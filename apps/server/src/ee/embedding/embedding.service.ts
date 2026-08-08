import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { sql } from 'kysely';
import { embed, embedMany } from 'ai';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
import { chunkText } from './chunk-text';

/** Must match the dimension pinned by the page_embeddings migration. */
export const EMBEDDING_DIMENSION = 1536;
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Модели, вывод которых сужается до нужной ширины без переобучения
 * (Matryoshka representation learning). Для них запрашивается ровно ширина
 * колонки вместо отказа от настройки.
 *
 * Список именно перечислением, а не «слать всегда»: `text-embedding-ada-002`
 * на параметр `dimensions` отвечает `400 This model does not support
 * specifying dimensions`. Проверено живым вызовом через OpenRouter вместе с
 * остальными: `text-embedding-3-*`, `gemini-embedding-001` и
 * `qwen3-embedding-8b` сужаются до 1536, а `bge-m3` и `multilingual-e5-large`
 * параметр молча игнорируют и остаются на 1024.
 *
 * Сравнивается имя без префикса поставщика: у шлюзов вроде OpenRouter то же
 * имя модели идет как `openai/text-embedding-3-small`.
 */
const MRL_MODEL_PATTERNS = [
  /^text-embedding-3-/,
  /^gemini-embedding-/,
  /^qwen3-embedding-/,
];

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
    private readonly aiSettingsService: AiSettingsService,
    private readonly providerFactory: AiProviderFactory,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  /**
   * Without a workspace this can only answer from the environment, which is what
   * the queue processor needs before it knows whose pages it is indexing.
   */
  async isConfigured(workspaceId?: string): Promise<boolean> {
    if (!workspaceId) {
      return Boolean(this.environmentService.getOpenAiApiKey());
    }
    const config = await this.aiSettingsService.resolveEmbedding(workspaceId);
    return config.driver === 'ollama'
      ? Boolean(config.baseUrl)
      : Boolean(config.apiKey);
  }

  /**
   * Идентичность векторного пространства: провайдер и модель.
   *
   * Имени модели недостаточно с тех пор, как провайдер выбирается: одно и то
   * же имя у разных провайдеров дает разные векторы, а сравнение векторов из
   * разных пространств возвращает правдоподобный шум, а не ошибку.
   */
  private async identity(
    workspaceId: string,
  ): Promise<{ driver: string; modelName: string }> {
    const config = await this.aiSettingsService.resolveEmbedding(workspaceId);
    return {
      driver: config.driver || 'openai',
      modelName:
        config.model ||
        this.environmentService.getAiEmbeddingModel() ||
        DEFAULT_EMBEDDING_MODEL,
    };
  }

  private async modelName(workspaceId: string): Promise<string> {
    const config = await this.aiSettingsService.resolveEmbedding(workspaceId);
    return (
      config.model ||
      this.environmentService.getAiEmbeddingModel() ||
      DEFAULT_EMBEDDING_MODEL
    );
  }

  /**
   * Embeddings go into a fixed-width column, so a model whose output does not
   * match is a configuration error worth failing loudly on rather than
   * silently indexing nothing.
   */
  private async embeddingModel(workspaceId: string) {
    const config = await this.aiSettingsService.resolveEmbedding(workspaceId);

    // Ollama работает без ключа, остальным провайдерам ключ обязателен.
    if (!config.apiKey && config.driver !== 'ollama') {
      throw new BadRequestException(
        'Semantic search needs an embedding API key. Set one in Settings → AI, or set OPENAI_API_KEY.',
      );
    }

    const configured = this.environmentService.getAiEmbeddingDimension();
    if (!Number.isNaN(configured) && configured !== EMBEDDING_DIMENSION) {
      throw new BadRequestException(
        `AI_EMBEDDING_DIMENSION is ${configured} but the page_embeddings column is ${EMBEDDING_DIMENSION}. Change the variable or migrate the column.`,
      );
    }

    return this.providerFactory.createEmbeddingModel(
      config,
      await this.modelName(workspaceId),
    );
  }


  /**
   * text-embedding-3-large returns 3072 values by default, which will not fit
   * the column; asking for 1536 keeps the larger model usable as-is.
   */
  private async providerOptions(workspaceId: string) {
    const config = await this.aiSettingsService.resolveEmbedding(workspaceId);

    // Ключ `openai` в опциях понимают только клиенты с этим же API. У Gemini
    // и Ollama он был бы отправлен как неизвестное поле.
    if (
      config.driver !== 'openai' &&
      config.driver !== 'openrouter' &&
      config.driver !== 'openai-compatible'
    ) {
      return undefined;
    }

    const model = (await this.modelName(workspaceId)).split('/').pop() ?? '';
    if (!MRL_MODEL_PATTERNS.some((pattern) => pattern.test(model))) {
      return undefined;
    }
    return { openai: { dimensions: EMBEDDING_DIMENSION } };
  }


  /** Rebuild the embeddings for one page. No-op for pages with no text. */
  async indexPage(pageId: string): Promise<{ chunks: number }> {
    const page = await this.db
      .selectFrom('pages')
      .select(['id', 'title', 'textContent', 'spaceId', 'workspaceId', 'deletedAt'])
      .where('id', '=', pageId)
      .executeTakeFirst();

    if (!page || page.deletedAt) {
      await this.removePage(pageId);
      return { chunks: 0 };
    }

    // The title carries a lot of the meaning of a wiki page, so it is
    // prepended to every chunk rather than embedded once on its own.
    const body = (page.textContent || '').trim();
    const chunks = chunkText(body);

    if (chunks.length === 0) {
      await this.removePage(pageId);
      return { chunks: 0 };
    }

    const title = page.title || 'Untitled';
    const inputs = chunks.map((chunk) => `${title}\n\n${chunk.text}`);

    const { embeddings } = await embedMany({
      model: await this.embeddingModel(page.workspaceId),
      values: inputs,
      providerOptions: await this.providerOptions(page.workspaceId),
    });

    this.assertDimension(embeddings[0]?.length);

    const { driver, modelName } = await this.identity(page.workspaceId);

    // Delete-then-insert inside one transaction: a page must never be left
    // with a mix of old and new chunks if the insert fails halfway.
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('pageEmbeddings')
        .where('pageId', '=', pageId)
        .execute();

      await trx
        .insertInto('pageEmbeddings')
        .values(
          chunks.map((chunk, i) => ({
            pageId: page.id,
            spaceId: page.spaceId,
            workspaceId: page.workspaceId,
            modelName,
            driver,
            modelDimensions: EMBEDDING_DIMENSION,
            embedding: sql`${JSON.stringify(embeddings[i])}::vector`,
            chunkIndex: i,
            chunkStart: chunk.start,
            chunkLength: chunk.text.length,
            metadata: JSON.stringify({ title }),
          })) as any,
        )
        .execute();
    });

    return { chunks: chunks.length };
  }

  /**
   * Перестроить эмбеддинги всего рабочего пространства.
   *
   * Обход идет по **всем** страницам, а не по «непроиндексированным»:
   * переиндексация запускается сменой провайдера или модели, то есть когда
   * прежние векторы недействительны целиком. Заодно это снимает ловушку
   * бесконечного цикла — страница без текста строк не получает и осталась бы
   * «непроиндексированной» навсегда.
   *
   * Постраничный обход по ключу, а не `offset`: индексация меняет таблицу
   * векторов, но не порядок страниц, поэтому keyset устойчив.
   */
  async indexWorkspace(
    workspaceId: string,
  ): Promise<{ indexed: number; failed: number }> {
    const BATCH = 50;
    let after: string | null = null;
    let indexed = 0;
    let failed = 0;

    for (;;) {
      const pages = await this.db
        .selectFrom('pages')
        .select('id')
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .$if(Boolean(after), (qb) => qb.where('id', '>', after))
        .orderBy('id', 'asc')
        .limit(BATCH)
        .execute();

      if (pages.length === 0) break;
      after = pages[pages.length - 1].id;

      for (const page of pages) {
        try {
          await this.indexPage(page.id);
          indexed += 1;
        } catch (err: any) {
          // Одна страница не должна останавливать перестроение всего
          // пространства.
          failed += 1;
          this.logger.warn(
            `Не удалось проиндексировать страницу ${page.id}: ${
              err?.message ?? err
            }`,
          );
        }
      }
    }

    return { indexed, failed };
  }

  /** Снять эмбеддинги всего рабочего пространства. */
  async removeWorkspace(workspaceId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('pageEmbeddings')
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  }

  async removePage(pageId: string): Promise<void> {
    await this.db
      .deleteFrom('pageEmbeddings')
      .where('pageId', '=', pageId)
      .execute();
  }

  private async embedQuery(
    query: string,
    workspaceId: string,
  ): Promise<number[]> {
    const { embedding } = await embed({
      model: await this.embeddingModel(workspaceId),
      value: query,
      providerOptions: await this.providerOptions(workspaceId),
    });

    this.assertDimension(embedding.length);
    return embedding;
  }

  /**
   * Ширина вектора у провайдера должна совпадать с шириной колонки.
   *
   * Пока провайдером был только OpenAI, несовпадение снималось опцией
   * `dimensions`. У Gemini и Ollama такой опции нет, и модель на 768 значений
   * упала бы ошибкой Postgres при вставке, из которой не видно, что менять.
   */
  private assertDimension(length: number | undefined): void {
    if (length === undefined || length === EMBEDDING_DIMENSION) return;

    throw new BadRequestException(
      `The embedding model returns ${length} values, but the page_embeddings column is ${EMBEDDING_DIMENSION}. Pick a model of that width in Settings → AI.`,
    );
  }

  /**
   * Nearest chunks by cosine distance, restricted to the given spaces.
   * Returns one row per page — the best-scoring chunk — so the caller is not
   * handed five fragments of the same document.
   */
  async search(opts: {
    query: string;
    workspaceId: string;
    userId: string;
    spaceIds: string[];
    limit: number;
  }) {
    const { query, workspaceId, userId, spaceIds, limit } = opts;

    if (spaceIds.length === 0) return [];

    const embedding = await this.embedQuery(query, workspaceId);
    const vector = sql`${JSON.stringify(embedding)}::vector`;

    // Vectors from different models live in unrelated spaces; comparing them
    // yields plausible-looking noise (~0.05 cosine) rather than an error.
    // Restricting to rows embedded by the current model turns a model switch
    // into visibly empty results until reindex_embeddings rebuilds the index.
    const current = await this.identity(workspaceId);

    const rows = await this.db
      .selectFrom('pageEmbeddings')
      .innerJoin('pages', 'pages.id', 'pageEmbeddings.pageId')
      .select([
        'pageEmbeddings.pageId',
        'pageEmbeddings.chunkIndex',
        'pageEmbeddings.chunkStart',
        'pageEmbeddings.chunkLength',
        'pages.title',
        'pages.slugId',
        'pages.spaceId',
        'pages.textContent',
        sql<number>`1 - (page_embeddings.embedding <=> ${vector})`.as(
          'similarity',
        ),
      ])
      .where('pageEmbeddings.workspaceId', '=', workspaceId)
      .where('pageEmbeddings.spaceId', 'in', spaceIds)
      .where('pageEmbeddings.modelName', '=', current.modelName)
      .where('pageEmbeddings.driver', '=', current.driver)
      .where('pages.deletedAt', 'is', null)
      // Over-fetch: several chunks of one page can crowd the top; the
      // page-permission filter below (after dedup) is what drops pages the
      // user cannot read, not the caller.
      .orderBy(sql`page_embeddings.embedding <=> ${vector}`)
      .limit(limit * 5)
      .execute();

    const bestPerPage = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!bestPerPage.has(row.pageId)) bestPerPage.set(row.pageId, row);
    }

    const candidates = [...bestPerPage.values()];

    // Vector distance ignores page-level restrictions. Filtering here rather
    // than at each call site is deliberate: the AI chat used to skip it.
    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: candidates.map((row) => row.pageId),
        userId,
      }),
    );

    return candidates
      .filter((row) => accessible.has(row.pageId))
      .map((row) => ({
        pageId: row.pageId,
        slugId: row.slugId,
        title: row.title,
        spaceId: row.spaceId,
        similarity: Number(row.similarity.toFixed(4)),
        excerpt: (row.textContent || '')
          .slice(row.chunkStart, row.chunkStart + row.chunkLength)
          .trim()
          .slice(0, 400),
      }));
  }

  /**
   * Pages with no embeddings for the CURRENT model. Rows left behind by a
   * previous model count as unindexed, so reindex_embeddings heals a model
   * switch instead of skipping every page as already done.
   */
  async findUnindexedPageIds(
    workspaceId: string,
    limit: number,
  ): Promise<string[]> {
    const current = await this.identity(workspaceId);

    const rows = await this.db
      .selectFrom('pages')
      .select('pages.id')
      .where('pages.workspaceId', '=', workspaceId)
      .where('pages.deletedAt', 'is', null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('pageEmbeddings')
              .select('pageEmbeddings.id')
              .whereRef('pageEmbeddings.pageId', '=', 'pages.id')
              .where('pageEmbeddings.modelName', '=', current.modelName)
              .where('pageEmbeddings.driver', '=', current.driver),
          ),
        ),
      )
      .limit(limit)
      .execute();

    return rows.map((r) => r.id);
  }

  async countIndexedPages(workspaceId: string): Promise<number> {
    const current = await this.identity(workspaceId);

    const row = await this.db
      .selectFrom('pageEmbeddings')
      .select((eb) => eb.fn.count<string>('pageId').distinct().as('count'))
      .where('workspaceId', '=', workspaceId)
      .where('modelName', '=', current.modelName)
      .where('driver', '=', current.driver)
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }
}
