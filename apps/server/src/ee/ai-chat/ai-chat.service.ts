import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { generateText, streamText } from 'ai';
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
import { needsWebSearch } from '../ai/freshness.util';
import { buildSearchPlan } from '../ai/search-plan.util';
import { AgentImageService } from './agent-image.service';
import { languageForRequest } from '../ai/request-language.util';
import { buildImageQuery, needsImages } from '../ai/image-request.util';
import { buildHistoryRecap } from './history-recap.util';
import { editRefusalNotice } from '../ai/ai-language.util';

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
      throw new NotFoundException('Chat not found');
    }

    if (chat.creatorId !== userId) {
      throw new ForbiddenException('Access denied');
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
      throw new NotFoundException('Chat not found');
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
      throw new NotFoundException('Chat not found');
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
      throw new BadRequestException('AI is not configured');
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
      throw new NotFoundException('Chat not found');
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

    // Without tools the model cannot go looking for anything, so pages the
    // question is about are retrieved up front. Explicitly supplied context
    // (a mention, the open page) is left as the authoritative source and only
    // topped up with whatever else the wiki has.
    const alreadyInContext = [
      ...(params.mentionedPageIds ?? []),
      params.contextPageId,
    ].filter(Boolean) as string[];

    const retrievalCallId = `retrieval-${chatId}-${history.length}`;
    yield {
      type: 'tool_call',
      id: retrievalCallId,
      name: 'search_pages',
      args: { query: params.content },
    };

    const retrieved = await this.retrieveWikiContext({
      query: params.content,
      workspaceId,
      userId,
      excludePageIds: alreadyInContext,
    });

    yield {
      type: 'tool_result',
      id: retrievalCallId,
      result: {
        method: retrieved.method,
        pages: retrieved.pages.map((p) => ({ id: p.id, title: p.title })),
      },
    };

    if (retrieved.pages.length > 0) {
      contextText +=
        '\n\n## Related pages found in the wiki\n' +
        retrieved.pages
          .map((p) => `### ${p.title} (ID: ${p.id})\n${p.excerpt}`)
          .join('\n\n');
    }

    // Шаг поиска сохраняется отдельно и подмешивается в `toolCalls` ниже:
    // сам массив объявляется после завершения потока, и запись в него
    // отсюда была бы обращением к переменной до объявления.
    let webToolCall: Record<string, unknown> | null = null;

    // Второй шаг поиска, рядом с поиском по вики и тем же механизмом: сервер
    // ищет сам, кладет найденное в подсказку и показывает наружу парой
    // tool_call/tool_result. Разметкой в ответе это сделать нельзя, ее
    // разбирают после завершения потока, и в рассуждение модели она бы уже
    // не попала.
    //
    // Решение о запуске принимается по характеру запроса, а не по пустой
    // выдаче из вики: запрос про текущие события нередко дает совпадение по
    // словам и все равно требует свежих данных.
    // Разговор, которому один раз понадобились внешние данные, нуждается в
    // них и дальше: признаки свежести есть в первом сообщении, а в уточнениях
    // вроде «добавь фото» их нет.
    const previousTurnSearched = history.some(
      (msg) =>
        Array.isArray(msg.toolCalls) &&
        (msg.toolCalls as any[]).some((call) => call?.name === 'search_web'),
    );

    // Просьба про изображения сама по себе требует смотреть наружу: в вики
    // постеров нет, а обычный поиск отдает страницы, а не картинки.
    const wantsImages = needsImages(params.content);

    if (
      (needsWebSearch(params.content, { previousTurnSearched }) ||
        wantsImages) &&
      (await this.webSearchService.isConfigured(workspaceId))
    ) {
      const webCallId = `websearch-${chatId}-${history.length}`;

      // Несколько заходов с разными формулировками вместо одного: одна выдача
      // одного формулирования давала обрывок, из которого агент собирал
      // страницу и публиковал ее как результат.
      const plan = buildSearchPlan(params.content, new Date().getFullYear());

      yield {
        type: 'tool_call',
        id: webCallId,
        name: 'search_web',
        args: { queries: plan },
      };

      const webResults = await this.webSearchService.searchMany(
        plan,
        workspaceId,
      );

      // Запрос картинок строится отдельно: слова про формат («фото»,
      // «постеры») описывают не предмет поиска, а то, что с ним сделать, и в
      // запросе изображений только мешают.
      const images = wantsImages
        ? await this.webSearchService.searchImages(
            buildImageQuery(params.content),
            workspaceId,
          )
        : [];

      const webResult = {
        count: webResults.length,
        results: webResults.map((r) => ({ title: r.title, url: r.url })),
        images: images.length,
      };

      yield { type: 'tool_result', id: webCallId, result: webResult };

      webToolCall = {
        id: webCallId,
        name: 'search_web',
        args: { queries: plan },
        result: webResult,
      };

      if (webResults.length > 0) {
        contextText +=
          '\n\n## Results from the web\n' +
          `These came from ${plan.length} live web searches run just now ` +
          `(${plan.map((q) => `"${q}"`).join(', ')}). Prefer them over ` +
          'your own recollection for anything time-sensitive, and cite the ' +
          'links you used.\n' +
          webResults
            .map((r) => `### ${r.title}\n${r.url}\n${r.snippet}`)
            .join('\n\n');
      }

      if (images.length > 0) {
        contextText +=
          '\n\n## Images found for this request\n' +
          'The user asked for pictures. Embed the relevant ones with ' +
          'markdown image syntax `![caption](url)` directly in the page, one ' +
          'per item where it fits. Do not replace a picture with a link to ' +
          'the page it came from.\n' +
          images
            .map((i) => `- ${i.title || 'без названия'}: ${i.imageUrl}`)
            .join('\n');
      }
    }

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

    // Stream the AI response (without SDK tools due to Zod v4 incompatibility)
    // Instead, editing is handled via command parsing from the AI response text
    const result = streamText({
      model: await this.providerFactory.getChatModel(workspaceId),
      system: systemPrompt,
      messages,
    });

    let fullResponse = '';

    for await (const chunk of (result as any).fullStream) {
      if (chunk.type === 'text-delta') {
        const text = chunk.textDelta ?? chunk.text ?? '';
        fullResponse += text;
        yield { type: 'content', text };
      }
    }

    // Parse and execute edit commands from the AI response
    const edits = await this.parseAndExecuteEditCommands(
      fullResponse,
      user,
      workspaceId,
    );

    const toolCalls: Array<Record<string, unknown>> = [
      ...(webToolCall ? [webToolCall] : []),
      {
        id: retrievalCallId,
        name: 'search_pages',
        args: { query: params.content },
        result: {
          method: retrieved.method,
          pages: retrieved.pages.map((p) => ({ id: p.id, title: p.title })),
        },
      },
    ];

    for (const [index, edit] of edits.entries()) {
      const callId = `edit-${chatId}-${history.length}-${index}`;
      const name =
        edit.action === 'title'
          ? 'update_page_title'
          : edit.action === 'create'
            ? 'create_page'
            : 'update_page';
      const args = edit.title
        ? { pageId: edit.pageId, title: edit.title }
        : { pageId: edit.pageId };
      const result = edit.applied
        ? { status: 'applied' }
        : { status: 'refused', reason: edit.reason };

      yield { type: 'tool_call', id: callId, name, args };
      yield { type: 'tool_result', id: callId, result };

      toolCalls.push({ id: callId, name, args, result });
    }

    // The model has already claimed the edit was made by this point, so a
    // refusal has to be stated in the transcript — otherwise the user is left
    // believing a change landed when it did not.
    const refused = edits.filter((edit) => !edit.applied);
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
   * Parse edit commands from AI response text and execute them.
   * Commands follow the format:
   * :::EDIT_PAGE:::
   * {"pageId":"...","content":"...","operation":"append|prepend|replace"}
   * :::END_EDIT:::
   *
   * Or for title updates:
   * :::UPDATE_TITLE:::
   * {"pageId":"...","title":"..."}
   * :::END_TITLE:::
   */
  private async parseAndExecuteEditCommands(
    responseText: string,
    user: User,
    workspaceId: string,
  ): Promise<EditOutcome[]> {
    const outcomes: EditOutcome[] = [];

    // Разбор CREATE_PAGE идет первым: созданная страница может быть целью
    // последующей правки в том же ответе.
    const createRegex = /:::CREATE_PAGE:::\s*\n([\s\S]*?)\n:::END_CREATE:::/g;
    let createMatch: RegExpExecArray | null;

    while ((createMatch = createRegex.exec(responseText)) !== null) {
      let command: any;
      try {
        command = JSON.parse(createMatch[1].trim());
      } catch {
        continue;
      }

      const created = await this.createPageForUser(command, user, workspaceId);
      outcomes.push(created);
    }

    // Parse EDIT_PAGE commands
    const editRegex = /:::EDIT_PAGE:::\s*\n([\s\S]*?)\n:::END_EDIT:::/g;
    let match: RegExpExecArray | null;

    while ((match = editRegex.exec(responseText)) !== null) {
      let command: any;
      try {
        command = JSON.parse(match[1].trim());
      } catch {
        continue; // Skip malformed commands
      }

      const reference = command?.page ?? command?.pageId;
      if (!reference || !command?.content) continue;

      const page = await this.authorizeEdit(reference, user, workspaceId);
      if (!page.allowed) {
        outcomes.push({
          pageId: String(reference),
          action: 'content',
          applied: false,
          reason: page.reason,
          refusal: page.refusal,
        });
        continue;
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
        outcomes.push({
          pageId: command.pageId,
          action: 'content',
          applied: true,
        });
      } catch (err: any) {
        outcomes.push({
          pageId: command.pageId,
          action: 'content',
          applied: false,
          reason: err?.message ?? 'The edit could not be applied',
        });
      }
    }

    // Parse UPDATE_TITLE commands
    const titleRegex = /:::UPDATE_TITLE:::\s*\n([\s\S]*?)\n:::END_TITLE:::/g;

    while ((match = titleRegex.exec(responseText)) !== null) {
      let command: any;
      try {
        command = JSON.parse(match[1].trim());
      } catch {
        continue;
      }

      const reference = command?.page ?? command?.pageId;
      if (!reference || !command?.title) continue;

      const page = await this.authorizeEdit(reference, user, workspaceId);
      if (!page.allowed) {
        outcomes.push({
          pageId: String(reference),
          action: 'title',
          applied: false,
          reason: page.reason,
          refusal: page.refusal,
        });
        continue;
      }

      await this.pageRepo.updatePage(
        { title: command.title, updatedAt: new Date() },
        page.page.id,
      );
      outcomes.push({ pageId: page.page.id, action: 'title', applied: true });
    }

    return outcomes;
  }

  /**
   * Pulls pages related to the question from the spaces the user belongs to.
   * Prefers semantic search when embeddings are configured and falls back to
   * PostgreSQL full-text search, so the assistant is not blind on installs
   * without an embedding key.
   */
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
        return {
          pageId: String(command.parentPageId),
          action: 'create',
          applied: false,
          reason: parent.reason,
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
      'You can create and edit document pages directly. When the user asks you to edit, update, add text to, format, or modify a page, ' +
      'include an edit command block in your response using this exact format:\n\n' +
      ':::EDIT_PAGE:::\n' +
      '{"page":"PAGE_REFERENCE_HERE","content":"MARKDOWN_CONTENT_HERE","operation":"append"}\n' +
      ':::END_EDIT:::\n\n' +
      'PAGE_REFERENCE can be the page address the user pasted (for example ' +
      'http://host/s/general/p/notes-pOHJzJpYni or /share/abc/p/notes-pOHJzJpYni), the slug ' +
      '(notes-pOHJzJpYni), or the page id. Use whatever the user gave you — never ask the user ' +
      'for an internal page id, the product does not show one anywhere.\n' +
      'To create a new page, use:\n\n' +
      ':::CREATE_PAGE:::\n' +
      '{"title":"PAGE_TITLE_HERE","content":"MARKDOWN_CONTENT_HERE"}\n' +
      ':::END_CREATE:::\n\n' +
      'Add "parentPageId":"PAGE_REFERENCE_HERE" to create it under an existing page; omit it to ' +
      'create the page at the root of the space. Never refuse a request to create a page on the ' +
      'grounds that you cannot create pages.\n' +
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
      'The "operation" can be "append" (add to bottom), "prepend" (add to top), or "replace" (overwrite entire document).\n' +
      'To update a page title, use:\n\n' +
      ':::UPDATE_TITLE:::\n' +
      '{"page":"PAGE_REFERENCE_HERE","title":"NEW_TITLE_HERE"}\n' +
      ':::END_TITLE:::\n\n' +
      'Only edit a page the user asked you to change. Never use "replace" unless the user explicitly asks to ' +
      'rewrite or overwrite the whole page — it discards the current content. Prefer "append" or "prepend". ' +
      'An edit can be refused by the permission system; when that happens you are told so, and you must ' +
      'report it to the user rather than claiming the change was made.\n' +
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
