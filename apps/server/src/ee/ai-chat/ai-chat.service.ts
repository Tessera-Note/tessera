import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { generateText, stepCountIs, streamText } from 'ai';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { sql } from 'kysely';
import { PageService } from '../../core/page/services/page.service';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { Page, User } from '@tessera/db/types/entity.types';
import { ContentOperation } from '../../core/page/dto/update-page.dto';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
import { normalizePageReference } from './page-reference.util';
import { WebSearchService } from '../ai/web-search.service';
import { AgentImageService } from './agent-image.service';
import { languageForRequest } from '../ai/request-language.util';
import { buildImageQuery } from '../ai/image-request.util';
import { buildHistoryRecap } from './history-recap.util';
import { editRefusalNotice } from '../ai/ai-language.util';
import { AGENT_MAX_STEPS, buildAgentTools } from './agent-tools';
import { badRequest, forbidden, notFound } from '../../common/errors/app-error';

/** How many wiki pages get pulled into the prompt when retrieving context. */
const RETRIEVAL_LIMIT = 5;
/** Characters of each retrieved page handed to the model. */
const RETRIEVAL_EXCERPT = 1500;

/**
 * Почему правка не применилась.
 *
 * Раньше причина была одна на все случаи, и человек, у которого страница
 * существует и открыта всем, шел проверять права. Настоящей причиной был
 * формат идентификатора.
 */
type EditRefusal = 'bad-reference' | 'not-found' | 'forbidden';

type EditOutcome = {
  pageId: string;
  /** Нужен пересказу истории: по одному идентификатору ход не прочитать. */
  title?: string;
  action: 'content' | 'title' | 'create';
  applied: boolean;
  reason?: string;
  refusal?: EditRefusal;
};

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly providerFactory: AiProviderFactory,
    private readonly agentImageService: AgentImageService,
    private readonly pageService: PageService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly webSearchService: WebSearchService,
    private readonly embeddingService: EmbeddingService,
    private readonly environmentService: EnvironmentService,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async createChat(userId: string, workspaceId: string) {
    const chat = await this.db
      .insertInto('aiChats')
      .values({
        workspaceId,
        creatorId: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return chat;
  }

  async listChats(
    userId: string,
    workspaceId: string,
    params?: { limit?: number; cursor?: string },
  ) {
    const limit = Math.min(params?.limit || 30, 100);

    let query = this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', userId)
      .where('deletedAt', 'is', null)
      .orderBy('updatedAt', 'desc')
      .limit(limit + 1);

    if (params?.cursor) {
      query = query.where('id', '<', params.cursor);
    }

    const results = await query.execute();
    const hasNextPage = results.length > limit;
    const items = hasNextPage ? results.slice(0, limit) : results;

    return {
      items,
      meta: {
        hasNextPage,
        nextCursor: hasNextPage ? items[items.length - 1]?.id : undefined,
        limit,
      },
    };
  }

  async getChatInfo(chatId: string, userId: string, workspaceId: string) {
    const chat = await this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('id', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!chat) {
      throw notFound('error.ai_chat.chat_not_found');
    }

    if (chat.creatorId !== userId) {
      throw forbidden('error.ai_chat.access_denied');
    }

    const messages = await this.db
      .selectFrom('aiChatMessages')
      .selectAll()
      .where('chatId', '=', chatId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();

    return { chat, messages };
  }

  async deleteChat(chatId: string, userId: string, workspaceId: string) {
    const chat = await this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('id', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', userId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!chat) {
      throw notFound('error.ai_chat.chat_not_found');
    }

    await this.db
      .updateTable('aiChats')
      .set({ deletedAt: new Date() })
      .where('id', '=', chatId)
      .execute();
  }

  async updateChatTitle(
    chatId: string,
    title: string,
    userId: string,
    workspaceId: string,
  ) {
    const chat = await this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('id', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', userId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!chat) {
      throw notFound('error.ai_chat.chat_not_found');
    }

    await this.db
      .updateTable('aiChats')
      .set({ title, updatedAt: new Date() })
      .where('id', '=', chatId)
      .execute();
  }

  async searchChats(query: string, userId: string, workspaceId: string) {
    const tsQuery = query
      .trim()
      .split(/\s+/)
      .map((word) => `${word}:*`)
      .join(' & ');

    // Search in chat titles
    const titleResults = await this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', userId)
      .where('deletedAt', 'is', null)
      .where('title', 'ilike', `%${query}%`)
      .orderBy('updatedAt', 'desc')
      .limit(20)
      .execute();

    // Search in messages
    const messageResults = await this.db
      .selectFrom('aiChatMessages')
      .innerJoin('aiChats', 'aiChats.id', 'aiChatMessages.chatId')
      .select([
        'aiChats.id',
        'aiChats.workspaceId',
        'aiChats.creatorId',
        'aiChats.title',
        'aiChats.createdAt',
        'aiChats.updatedAt',
        'aiChats.deletedAt',
      ])
      .where('aiChats.workspaceId', '=', workspaceId)
      .where('aiChats.creatorId', '=', userId)
      .where('aiChats.deletedAt', 'is', null)
      .where('aiChatMessages.deletedAt', 'is', null)
      .where(
        sql<boolean>`ai_chat_messages.tsv @@ to_tsquery('english', ${tsQuery})`,
      )
      .groupBy([
        'aiChats.id',
        'aiChats.workspaceId',
        'aiChats.creatorId',
        'aiChats.title',
        'aiChats.createdAt',
        'aiChats.updatedAt',
        'aiChats.deletedAt',
      ])
      .orderBy('aiChats.updatedAt', 'desc')
      .limit(20)
      .execute();

    // Merge and deduplicate
    const seen = new Set<string>();
    const combined = [];

    for (const chat of [...titleResults, ...messageResults]) {
      if (!seen.has(chat.id)) {
        seen.add(chat.id);
        combined.push(chat);
      }
    }

    return combined.slice(0, 20);
  }

  async *sendMessage(
    params: {
      chatId?: string;
      content: string;
      mentionedPageIds?: string[];
      contextPageId?: string;
      attachmentIds?: string[];
    },
    user: User,
    workspaceId: string,
  ) {
    if (!(await this.providerFactory.isConfigured(workspaceId))) {
      throw badRequest('error.common.ai_is_not_configured');
    }

    const userId = user.id;

    // Create or get chat
    let chatId = params.chatId;
    if (!chatId) {
      const chat = await this.createChat(userId, workspaceId);
      chatId = chat.id;
      yield { type: 'chat_created', chatId };
    }

    // Verify chat ownership
    const chat = await this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('id', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', userId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!chat) {
      throw notFound('error.ai_chat.chat_not_found');
    }

    // Save user message
    await this.db
      .insertInto('aiChatMessages')
      .values({
        chatId,
        workspaceId,
        userId,
        role: 'user',
        content: params.content,
        metadata: params.mentionedPageIds?.length
          ? JSON.stringify({ mentionedPageIds: params.mentionedPageIds })
          : null,
      })
      .execute();

    // Get conversation history
    const history = await this.db
      .selectFrom('aiChatMessages')
      // `toolCalls` нужны для пересказа прошлых ходов: адреса созданных
      // страниц и найденное живут только там.
      .select(['role', 'content', 'toolCalls'])
      .where('chatId', '=', chatId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();

    // Build context from mentioned pages
    let contextText = '';
    if (params.mentionedPageIds?.length) {
      const mentioned = await this.db
        .selectFrom('pages')
        .select(['id', 'spaceId', 'title', 'content'])
        .where('id', 'in', params.mentionedPageIds)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute();

      const pages = await this.filterViewablePages(mentioned, user);

      if (pages.length > 0) {
        contextText = pages
          .map(
            (p) => `## ${p.title}\n${this.extractTextFromContent(p.content)}`,
          )
          .join('\n\n');
      }
    }

    if (params.contextPageId) {
      const page = await this.db
        .selectFrom('pages')
        .select(['id', 'spaceId', 'title', 'content'])
        .where('id', '=', params.contextPageId)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();

      const [viewable] = page
        ? await this.filterViewablePages([page], user)
        : [];

      if (viewable) {
        contextText += `\n\n## Current page (ID: ${viewable.id}, Title: ${viewable.title}):\n${this.extractTextFromContent(viewable.content)}`;
      }
    }

    // Явно поданный контекст остается источником: упоминание страницы и
    // открытая страница уже в подсказке. Искать остальное модель решает сама,
    // инструментом.
    const alreadyInContext = [
      ...(params.mentionedPageIds ?? []),
      params.contextPageId,
    ].filter(Boolean) as string[];

    // Build messages for AI SDK
    //
    // К содержимому ответа приписывается пересказ того, что на том ходе было
    // сделано: без него агент не знает адреса страницы, которую сам создал, и
    // на просьбу «расширь страницу» просит прислать ссылку на нее же.
    const messages: any[] = history.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content:
        msg.role === 'assistant'
          ? `${msg.content || ''}${buildHistoryRecap(msg.toolCalls)}`
          : msg.content || '',
    }));

    const systemPrompt = this.buildSystemPrompt(
      contextText,
      params.contextPageId,
      // Язык решает сервер, а не модель: на смешанном тексте модель угадывает
      // по-разному от раза к разу, и ответ зависел бы от одной опечатки.
      languageForRequest(params.content, user.locale),
    );

    // Инструменты вместо разметки в тексте.
    //
    // Прежде поле `tools` в вызов не передавалось, а «команды» агент писал в
    // ответ разметкой, которую сервер разбирал после завершения потока. Из-за
    // этого результат действия не возвращался в рассуждение модели, второго
    // прохода не было, а поиск инструментом не был вовсе: сервер искал сам до
    // вызова модели. Совместимость схем Zod v4 проверена живым прогоном и
    // восстановлена.
    //
    // Правка предлагается только тому, кому она разрешена: у чата без права
    // правки инструментов правки нет, и модель не предложит того, что все
    // равно будет отвергнуто.
    const toolCalls: Array<Record<string, unknown>> = [];
    const outcomes: EditOutcome[] = [];

    const remember = (
      id: string,
      name: string,
      args: unknown,
      result: unknown,
    ) => {
      toolCalls.push({ id, name, args, result });
    };

    const tools = buildAgentTools({
      searchPages: async ({ query }) => {
        const found = await this.retrieveWikiContext({
          query,
          workspaceId,
          userId,
          excludePageIds: alreadyInContext,
        });

        return {
          method: found.method,
          pages: found.pages.map((page) => ({
            id: page.id,
            title: page.title,
            excerpt: page.excerpt,
          })),
        };
      },

      searchWeb: (await this.webSearchService.isConfigured(workspaceId))
        ? async ({ queries, images }) => {
            const results = await this.webSearchService.searchMany(
              queries,
              workspaceId,
            );

            // Картинки ищутся по запросу модели, а не по исходному сообщению
            // человека. Прежде объявленный аргумент `queries` до поиска
            // картинок не доходил вовсе: модель просила одно, сервер искал по
            // другому. Это тот же класс, что и молча игнорируемый аргумент у
            // создания страницы.
            //
            // Чистка запроса остается: слова про формат описывают не предмет
            // поиска, а то, что с ним сделать, и в запросе изображений мешают.
            const pictures = images
              ? await this.webSearchService.searchImages(
                  buildImageQuery(queries[0]),
                  workspaceId,
                )
              : [];

            return {
              count: results.length,
              results: results.map((r) => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet,
              })),
              images: pictures.map((i) => ({
                title: i.title,
                url: i.imageUrl,
              })),
            };
          }
        : undefined,

      createPage: async (input) => {
        const outcome = await this.createPageForUser(input, user, workspaceId);
        outcomes.push(outcome);
        return outcome.applied
          ? { status: 'applied', pageId: outcome.pageId }
          : { status: 'refused', reason: outcome.reason };
      },

      editPage: async ({ page, content, operation }) => {
        const outcome = await this.applyPageEdit(
          { page, content, operation },
          user,
          workspaceId,
        );
        outcomes.push(outcome);
        return outcome.applied
          ? { status: 'applied', pageId: outcome.pageId }
          : { status: 'refused', reason: outcome.reason };
      },

      updateTitle: async ({ page, title }) => {
        const outcome = await this.applyTitleChange(
          { page, title },
          user,
          workspaceId,
        );
        outcomes.push(outcome);
        return outcome.applied
          ? { status: 'applied', pageId: outcome.pageId }
          : { status: 'refused', reason: outcome.reason };
      },
    });

    const result = streamText({
      model: await this.providerFactory.getChatModel(workspaceId),
      system: systemPrompt,
      messages,
      tools,
      // Без этого модель останавливается на первом же вызове инструмента и
      // ответа не пишет: результат к ней уже не возвращается.
      stopWhen: stepCountIs(AGENT_MAX_STEPS),
    });

    let fullResponse = '';
    const argsByCall = new Map<string, unknown>();

    for await (const chunk of (result as any).fullStream) {
      if (chunk.type === 'text-delta') {
        const text = chunk.text ?? chunk.delta ?? chunk.textDelta ?? '';
        fullResponse += text;
        yield { type: 'content', text };
        continue;
      }

      if (chunk.type === 'tool-call') {
        const args = chunk.input ?? chunk.args ?? {};
        argsByCall.set(chunk.toolCallId, args);
        yield {
          type: 'tool_call',
          id: chunk.toolCallId,
          name: chunk.toolName,
          args,
        };
        continue;
      }

      if (chunk.type === 'tool-result') {
        const output = chunk.output ?? chunk.result;
        yield { type: 'tool_result', id: chunk.toolCallId, result: output };
        remember(
          chunk.toolCallId,
          chunk.toolName,
          argsByCall.get(chunk.toolCallId) ?? {},
          output,
        );
        continue;
      }

      if (chunk.type === 'tool-error') {
        // Отказ инструмента возвращается модели и ей же объясняется человеку,
        // но в запись хода он обязан попасть: иначе разбор происшествия
        // упирается в ответ, где действие просто не упомянуто.
        const failure = {
          status: 'failed',
          reason:
            chunk.error instanceof Error
              ? chunk.error.message
              : String(chunk.error),
        };
        yield { type: 'tool_result', id: chunk.toolCallId, result: failure };
        remember(
          chunk.toolCallId,
          chunk.toolName,
          argsByCall.get(chunk.toolCallId) ?? {},
          failure,
        );
      }
    }

    // Отказ теперь возвращается модели внутри разговора, и она может
    // повторить вызов иначе. Приписка остается страховкой на случай, когда
    // сделать не удалось совсем: молчаливый отказ недопустим.
    //
    // Считается только то, что осталось несделанным к концу хода. Модель
    // получает отказ и пробует снова, и приписка о первой неудачной попытке
    // прямо противоречила бы ответу: замечено на живом разговоре, где
    // страница была создана с четвертой попытки, а человек прочел
    // предупреждение, что правки не применены.
    const succeededActions = new Set(
      outcomes.filter((edit) => edit.applied).map((edit) => edit.action),
    );
    const refused = outcomes.filter(
      (edit) => !edit.applied && !succeededActions.has(edit.action),
    );
    if (refused.length > 0) {
      const notice = editRefusalNotice(
        user.locale,
        refused.length,
        refused.map((edit) => edit.refusal).filter(Boolean) as any,
      );
      fullResponse += `\n\n${notice}`;
      yield { type: 'content', text: `\n\n${notice}` };
    }

    // Save assistant message
    const assistantMsg = await this.db
      .insertInto('aiChatMessages')
      .values({
        chatId,
        workspaceId,
        role: 'assistant',
        content: fullResponse,
        // Persisted so the steps survive a page reload, not just the stream.
        // Pass the array itself: JSON.stringify would be stored as a JSON
        // *string* by postgres-js, and the client expects an array here.
        toolCalls: toolCalls as any,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    // Auto-generate title if it's the first exchange
    if (!chat.title && history.length <= 1) {
      this.autoGenerateTitle(
        chatId,
        params.content,
        fullResponse,
        workspaceId,
      ).catch(() => {});
    }

    // Update chat timestamp
    await this.db
      .updateTable('aiChats')
      .set({ updatedAt: new Date() })
      .where('id', '=', chatId)
      .execute();

    yield { type: 'done', messageId: assistantMsg.id };
  }

  /**
   * Записать содержимое в страницу.
   *
   * Раньше это делал разбор разметки из текста ответа, теперь зовет
   * инструмент. Проверка прав осталась прежней и на каждую страницу
   * отдельная: у чата единого признака «можно править» нет, и заводить его
   * значило бы второе правило для одного действия.
   */
  private async applyPageEdit(
    command: { page: string; content: string; operation?: string },
    user: User,
    workspaceId: string,
  ): Promise<EditOutcome> {
    const page = await this.authorizeEdit(command.page, user, workspaceId);

    if (!page.allowed) {
      return {
        pageId: String(command.page),
        action: 'content',
        applied: false,
        reason: page.reason,
        refusal: page.refusal,
      };
    }

    try {
      // Картинки переносятся во вложения до записи: внешний адрес в теле
      // страницы отправлял бы браузер читателя на чужой сервер.
      const content = await this.agentImageService.localizeImages(
        command.content,
        {
          pageId: page.page.id,
          spaceId: page.page.spaceId,
          workspaceId,
          userId: user.id,
        },
      );

      await this.pageService.updatePageContent(
        page.page.id,
        content,
        (command.operation || 'append') as ContentOperation,
        'markdown',
        user,
      );

      return { pageId: page.page.id, action: 'content', applied: true };
    } catch (err: any) {
      return {
        pageId: page.page.id,
        action: 'content',
        applied: false,
        reason: err?.message ?? 'The edit could not be applied',
      };
    }
  }

  /** Переименовать страницу. Права те же, что и у правки содержимого. */
  private async applyTitleChange(
    command: { page: string; title: string },
    user: User,
    workspaceId: string,
  ): Promise<EditOutcome> {
    const page = await this.authorizeEdit(command.page, user, workspaceId);

    if (!page.allowed) {
      return {
        pageId: String(command.page),
        action: 'title',
        applied: false,
        reason: page.reason,
        refusal: page.refusal,
      };
    }

    try {
      await this.pageRepo.updatePage(
        { title: command.title, updatedAt: new Date() },
        page.page.id,
      );

      return {
        pageId: page.page.id,
        action: 'title',
        applied: true,
        title: command.title,
      };
    } catch (err: any) {
      return {
        pageId: page.page.id,
        action: 'title',
        applied: false,
        reason: err?.message ?? 'The title could not be changed',
      };
    }
  }

  private async retrieveWikiContext(opts: {
    query: string;
    workspaceId: string;
    userId: string;
    excludePageIds: string[];
  }): Promise<{
    method: 'semantic' | 'text' | 'none';
    pages: Array<{ id: string; title: string; excerpt: string }>;
  }> {
    const { query, workspaceId, userId, excludePageIds } = opts;

    const trimmed = query.trim();
    if (trimmed.length < 3) return { method: 'none', pages: [] };

    const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);
    if (spaceIds.length === 0) return { method: 'none', pages: [] };

    const exclude = new Set(excludePageIds);

    try {
      if (await this.embeddingService.isConfigured(workspaceId)) {
        const hits = await this.embeddingService.search({
          query: trimmed,
          workspaceId,
          userId,
          spaceIds,
          limit: RETRIEVAL_LIMIT + exclude.size,
        });

        const pages = hits
          .filter((hit) => !exclude.has(hit.pageId))
          .slice(0, RETRIEVAL_LIMIT)
          .map((hit) => ({
            id: hit.pageId,
            title: hit.title || 'Untitled',
            excerpt: hit.excerpt,
          }));

        if (pages.length > 0) return { method: 'semantic', pages };
      }
    } catch {
      // Provider or index trouble must not take the chat down with it.
    }

    try {
      const pages = await this.textSearchPages({
        query: trimmed,
        workspaceId,
        userId,
        spaceIds,
        exclude,
      });
      if (pages.length > 0) return { method: 'text', pages };
    } catch {
      // Same reasoning as above.
    }

    return { method: 'none', pages: [] };
  }

  private async textSearchPages(opts: {
    query: string;
    workspaceId: string;
    userId: string;
    spaceIds: string[];
    exclude: Set<string>;
  }): Promise<Array<{ id: string; title: string; excerpt: string }>> {
    const { query, workspaceId, userId, spaceIds, exclude } = opts;

    // Prefix matching on every word, which is what makes short questions match
    // partial titles. Punctuation is stripped so it cannot break to_tsquery.
    //
    // The query must mirror how the pages trigger builds tsv — english
    // dictionary over f_unaccent — or accented words match nothing at all: the
    // index stores `producao`, so a query for `produção:*` finds no rows.
    const terms = query
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .slice(0, 8)
      .map((word) => `${word}:*`)
      .join(' | ');

    if (!terms) return [];

    const rows = await this.db
      .selectFrom('pages')
      .select(['id', 'title', 'textContent'])
      .where('workspaceId', '=', workspaceId)
      .where('spaceId', 'in', spaceIds)
      .where('deletedAt', 'is', null)
      .where(sql<boolean>`tsv @@ to_tsquery('english', f_unaccent(${terms}))`)
      .orderBy(
        sql`ts_rank(tsv, to_tsquery('english', f_unaccent(${terms})))`,
        'desc',
      )
      .limit(RETRIEVAL_LIMIT + exclude.size)
      .execute();

    const candidates = rows.filter((row) => !exclude.has(row.id));

    // Full-text search ignores page-level restrictions, same as the semantic
    // path in EmbeddingService.search. Filter before slicing so a restricted
    // page does not silently crowd out an accessible one within the limit.
    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: candidates.map((row) => row.id),
        userId,
      }),
    );

    return candidates
      .filter((row) => accessible.has(row.id))
      .slice(0, RETRIEVAL_LIMIT)
      .map((row) => ({
        id: row.id,
        title: row.title || 'Untitled',
        excerpt: (row.textContent || '').slice(0, RETRIEVAL_EXCERPT),
      }));
  }

  /**
   * Создание страницы по команде модели.
   *
   * Права проверяются как на обычном пути: `SpaceAbilityFactory` бросает, если
   * человек не состоит в пространстве, а `PageService.create` сам проверяет
   * родителя. Пространство выбирается по ссылке-родителю, иначе по текущей
   * странице контекста, иначе единственным доступным: просить у человека
   * идентификатор пространства так же бессмысленно, как идентификатор
   * страницы, он его не видит.
   */
  private async createPageForUser(
    command: any,
    user: User,
    workspaceId: string,
  ): Promise<EditOutcome> {
    const title =
      typeof command?.title === 'string' && command.title.trim()
        ? command.title.trim()
        : 'Untitled';

    let parentPageId: string | undefined;
    let spaceId: string | undefined;

    if (command?.parentPageId) {
      const parent = await this.authorizeEdit(
        command.parentPageId,
        user,
        workspaceId,
      );
      if (!parent.allowed) {
        // Отказ обязан говорить, что делать дальше. Иначе модель повторяет
        // тот же вызов с той же негодной ссылкой: замечено на живом разговоре,
        // где создание отказало трижды подряд, прежде чем родитель был
        // опущен и страница создалась.
        return {
          pageId: String(command.parentPageId),
          action: 'create',
          applied: false,
          reason: `${parent.reason}. Retry without parentPageId to create the page at the top level`,
          refusal: parent.refusal,
        };
      }
      parentPageId = parent.page.id;
      spaceId = parent.page.spaceId;
    }

    if (!spaceId) {
      const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(user.id);
      if (spaceIds.length === 0) {
        return {
          pageId: '',
          action: 'create',
          applied: false,
          reason: 'No space available to create the page in',
          refusal: 'forbidden',
        };
      }
      spaceId = spaceIds[0];
    }

    try {
      const page = await this.pageService.create(user.id, workspaceId, {
        title,
        spaceId,
        parentPageId,
      } as any);

      if (typeof command?.content === 'string' && command.content.trim()) {
        const content = await this.agentImageService.localizeImages(
          command.content,
          {
            pageId: page.id,
            spaceId,
            workspaceId,
            userId: user.id,
          },
        );

        await this.pageService.updatePageContent(
          page.id,
          content,
          'replace' as ContentOperation,
          'markdown',
          user,
        );
      }

      return { pageId: page.id, title, action: 'create', applied: true };
    } catch (err) {
      this.logger.warn(
        `Не удалось создать страницу по команде агента: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        pageId: '',
        action: 'create',
        applied: false,
        reason: 'Page could not be created',
        refusal: 'forbidden',
      };
    }
  }

  /**
   * The pageId in an edit command comes from model-generated text, so it is
   * untrusted input: it must be confined to the caller's workspace and pass the
   * same page/space permission check the REST endpoint applies. The collaboration
   * path used by updatePageContent opens a direct Yjs connection, which skips
   * the authentication extension entirely — nothing downstream will catch this.
   */
  private async authorizeEdit(
    reference: string,
    user: User,
    workspaceId: string,
  ): Promise<{
    allowed: boolean;
    reason?: string;
    refusal?: EditRefusal;
    page?: Page;
  }> {
    // Ссылка приводится к идентификатору или slug_id: пользователь внутреннего
    // идентификатора не видит и дает адрес страницы, а модель передает то, что
    // получила от него.
    const normalized = normalizePageReference(reference);

    if (!normalized) {
      return {
        allowed: false,
        refusal: 'bad-reference',
        reason: 'Page reference could not be understood',
      };
    }

    let page: Page | undefined;
    try {
      page = await this.pageRepo.findById(normalized);
    } catch {
      return {
        allowed: false,
        refusal: 'not-found',
        reason: 'Page not found',
      };
    }

    if (!page || page.deletedAt || page.workspaceId !== workspaceId) {
      return { allowed: false, refusal: 'not-found', reason: 'Page not found' };
    }

    try {
      await this.pageAccessService.validateCanEdit(page, user);
    } catch {
      return {
        allowed: false,
        refusal: 'forbidden',
        reason: 'You do not have permission to edit this page',
      };
    }

    return { allowed: true, page };
  }

  /**
   * Mentions and the context page arrive as raw ids from the client. Without
   * this the model would happily quote a restricted page back to the caller.
   */
  private async filterViewablePages<T extends { id: string; spaceId: string }>(
    pages: T[],
    user: User,
  ): Promise<T[]> {
    const checked = await Promise.all(
      pages.map(async (page) => {
        try {
          await this.pageAccessService.validateCanView(page as Page, user);
          return page;
        } catch (err) {
          if (!(err instanceof ForbiddenException)) {
            this.logger.warn(
              `filterViewablePages: unexpected error validating access to page ${page.id}, dropping it from context: ${err instanceof Error ? err.message : err}`,
            );
          }
          return null;
        }
      }),
    );

    return checked.filter((page) => page !== null) as T[];
  }

  private buildSystemPrompt(
    context: string,
    currentContextPageId?: string,
    language?: string,
  ): string {
    const appName = this.environmentService.getAppName();

    let prompt =
      `You are the AI assistant built into ${appName}, the company knowledge wiki. ` +
      `Users come to you to find, explain and maintain the documentation kept in ${appName}. ` +
      `Answer from the wiki content you are given, and say plainly when the wiki does not cover something ` +
      'instead of filling the gap with general knowledge presented as fact. ' +
      // Запасное значение то же, что у `DEFAULT_AI_LANGUAGE`: португальский
      // здесь был вторым наследием форка, и при незаданной локали агент
      // отвечал не на языке интерфейса.
      `Write in ${language ?? 'English'}. This has already been decided for ` +
      'you from the language of the request and the user profile — do not ' +
      'override it because a source you found is in another language. It ' +
      'applies to page content too, not just to your reply. ' +
      "When a question needs current information — today's events, recent " +
      'releases, prices, schedules, anything time-sensitive — a web search is ' +
      'run for you automatically and its results appear under "Results from ' +
      'the web" in your context. Use them and cite the links. Never answer ' +
      'that you cannot search the internet from this chat, and never hand ' +
      'back an empty template with placeholders when the answer requires ' +
      'fresh data you were given.\n' +
      // Замечено на живом сценарии: на просьбу про «текущий прокат» агент сам
      // выбрал рынок одной страны, потому что источник в выдаче оказался
      // региональным, и подал это как условие задачи.
      'Do not narrow the request on your own. If the user did not name a ' +
      'country, market, region or period, do not pick one because a source ' +
      'you found happens to cover it — answer the question as asked and say ' +
      'plainly which part you could not confirm.\n' +
      // Пересказ прошлых ходов приписывается к истории, но модель должна знать,
      // что этим можно пользоваться, а не просить у человека то, что уже есть.
      'Your previous messages carry a bracketed note listing the pages you ' +
      'created or edited and what you found. Those ids are yours to reuse: ' +
      'when the user says «that page» or asks to extend what you just made, ' +
      'act on the id from that note instead of asking for a link.\n' +
      // Разметки в тексте больше нет: действия делаются инструментами, и
      // подсказка описывает именно их. Прежний блок объяснял модели формат
      // `:::EDIT_PAGE:::`, который сервер разбирал уже после ответа.
      'You have tools. Use search_pages before answering anything about the ' +
      'workspace content, and search_web for facts that change over time or ' +
      'that the wiki does not cover. Do not answer from memory about either.\n' +
      'Use create_page, edit_page and update_title to change the wiki. The ' +
      'page argument accepts whatever the user gave you: a pasted address ' +
      '(http://host/s/general/p/notes-pOHJzJpYni), a slug (notes-pOHJzJpYni) ' +
      'or an id. Never ask the user for an internal page id, the product ' +
      'does not show one anywhere. Never refuse a request to create a page ' +
      'on the grounds that you cannot create pages.\n' +
      // Замечено на живом случае: на просьбу собрать топ-13 агент опубликовал
      // страницу с местами с девятого по тринадцатое и двумя врезками о том,
      // что данных нет. Это отчет о неудаче, оформленный как документ.
      'Ask before you publish something you know is incomplete. If the user ' +
      'asked for a list of N items and you can only confirm a few, or the ' +
      'request is ambiguous in a way that changes the answer, ask one short ' +
      'question first and create nothing. Never create a page whose body is ' +
      'mostly a notice about missing data, placeholders, or warning callouts ' +
      'explaining what you could not find — that is a report of failure ' +
      'dressed up as a document, and it is worse than a question.\n' +
      // «На свое усмотрение» это разрешение решить, а не повод отказаться.
      'When the user says the choice is yours, they are giving you permission ' +
      'to decide, not asking you to prove the choice is unknowable. Pick a ' +
      'reasonable interpretation, say in one line which one you picked, and ' +
      'deliver the whole thing.\n' +
      'The edit_page operation can be "append" (add to bottom), "prepend" ' +
      '(add to top), or "replace" (overwrite the whole document). Only edit a ' +
      'page the user asked you to change, and never use "replace" unless they ' +
      'explicitly asked to rewrite the page — it discards what is there.\n' +
      'A tool can answer that the change was refused by the permission ' +
      'system. When that happens, tell the user plainly instead of claiming ' +
      'the change was made.\n' +
      `You are capable of writing rich Markdown syntax that ${appName} renders into interactive UI elements:\n` +
      '- **Mermaid Diagrams**: Use ```mermaid code blocks for flowcharts, sequence diagrams, mindmaps, ERDs, and gantt charts.\n' +
      '- **Tables**: Use standard Markdown table syntax (| Header 1 | Header 2 |).\n' +
      '- **Code Blocks**: Use fenced code blocks with language identifiers (e.g., ```typescript, ```yaml, ```json, ```python).\n' +
      '- **Callouts/Alerts**: Use blockquotes with alert syntax (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION]).\n' +
      '- **Task Lists**: Use `- [ ]` and `- [x]` for interactive task checklists.\n' +
      'Format your responses using Markdown when appropriate.';

    if (currentContextPageId) {
      prompt += `\n\nThe user is currently viewing the page with ID: "${currentContextPageId}". Use this pageId for editing unless specified otherwise.`;
    }

    if (context) {
      prompt += `\n\nDocument context:\n\n${context}`;
    }

    return prompt;
  }

  private extractTextFromContent(content: any): string {
    if (!content) return '';
    if (typeof content === 'string') return content;

    // Handle Prosemirror/Tiptap JSON content
    try {
      const doc = typeof content === 'string' ? JSON.parse(content) : content;
      return this.extractTextFromNode(doc);
    } catch {
      return String(content);
    }
  }

  private extractTextFromNode(node: any): string {
    if (!node) return '';

    let text = '';

    if (node.text) {
      text += node.text;
    }

    if (node.content && Array.isArray(node.content)) {
      for (const child of node.content) {
        text += this.extractTextFromNode(child);
      }
      // Add newline after block-level nodes
      if (
        ['paragraph', 'heading', 'listItem', 'blockquote'].includes(node.type)
      ) {
        text += '\n';
      }
    }

    return text;
  }

  private async autoGenerateTitle(
    chatId: string,
    userMessage: string,
    assistantResponse: string,
    workspaceId: string,
  ) {
    try {
      if (!(await this.providerFactory.isConfigured(workspaceId))) return;

      const result = await generateText({
        model: await this.providerFactory.getCompletionModel(workspaceId),
        system:
          'Generate a very short title (max 6 words) for this conversation. ' +
          'Return only the title text, nothing else. No quotes or punctuation at the end.',
        prompt: `User: ${userMessage.substring(0, 200)}\nAssistant: ${assistantResponse.substring(0, 200)}`,
      });

      const title = result.text.trim().substring(0, 100);
      if (title) {
        await this.db
          .updateTable('aiChats')
          .set({ title })
          .where('id', '=', chatId)
          .execute();
      }
    } catch {
      // Silently fail - title generation is not critical
    }
  }
}
