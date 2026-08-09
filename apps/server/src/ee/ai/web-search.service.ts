import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { decryptSecret } from './ai-secret.util';

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

/** Картинка из выдачи: прямой адрес и страница, откуда она взята. */
export type WebImageResult = {
  title: string;
  imageUrl: string;
  sourceUrl: string;
};

/** Сколько результатов уходит в подсказку модели с одного захода. */
const RESULT_LIMIT = 5;

/**
 * Сколько источников уходит модели после объединения заходов.
 *
 * Пяти ссылок мало для перечисления из десятка позиций: агент собирал из них
 * обрывок и публиковал его как результат.
 */
const MERGED_LIMIT = 16;

/** Сколько картинок уходит модели: больше страница не выдержит. */
const IMAGE_LIMIT = 8;

/** Сколько символов берется от каждого сниппета. */
const SNIPPET_LIMIT = 500;

/** Предел ожидания провайдера: чат не должен зависать из-за поиска. */
const TIMEOUT_MS = 8000;

/** Свой сервис рядом в compose, ключ не нужен. */
const DEFAULT_SEARXNG_URL = 'http://tessera-searxng:8080';

/**
 * Поиск в интернете для ИИ агента.
 *
 * Основной источник это `tessera-searxng` рядом в compose: он не требует
 * ключа, не создает зависимости от чужого биллинга в закрытом контуре и не
 * ограничивает право хранить найденное в теле страницы вики. Tavily и Brave
 * подключаются ключом, когда своего индекса недостаточно.
 *
 * Все три вызываются обычным `fetch`: новых зависимостей в манифест не
 * добавляется.
 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
  ) {}

  /**
   * Настроен ли поиск для пространства.
   *
   * SearXNG считается настроенным всегда: он часть развертывания, а не
   * внешняя услуга. Если контейнер не поднят, поиск отвалится по таймауту и
   * чат продолжится без него.
   */
  async isConfigured(workspaceId: string): Promise<boolean> {
    const settings = await this.settings(workspaceId);
    if (!settings) return true;
    if (settings.driver === 'off') return false;
    if (settings.driver === 'searxng' || !settings.driver) return true;
    return Boolean(settings.apiKey);
  }

  /**
   * Несколько заходов подряд, результаты объединяются по адресу.
   *
   * Один заход одного формулирования это не «поискал», а «спросил один раз и
   * согласился с первым, что дали»: замерено на живом случае, где из пяти
   * ссылок агент собрал обрывок рейтинга и опубликовал его как результат.
   *
   * Заходы идут параллельно: свой сервис поиска рядом в compose, задержка
   * определяется самым медленным, а не суммой.
   */
  async searchMany(
    queries: string[],
    workspaceId: string,
  ): Promise<WebSearchResult[]> {
    if (queries.length === 0) return [];

    const rounds = await Promise.all(
      queries.map((query) => this.search(query, workspaceId)),
    );

    const seen = new Set<string>();
    const merged: WebSearchResult[] = [];

    for (const round of rounds) {
      for (const item of round) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        merged.push(item);
      }
    }

    return merged.slice(0, MERGED_LIMIT);
  }

  /**
   * Картинки по запросу.
   *
   * Просьба «с фото» не выполнялась вовсе: обычный поиск отдает страницы, а
   * не изображения, и агент вместо картинок ставил ссылку на источник.
   *
   * У своего сервиса режим картинок включается параметром запроса, у Tavily
   * тем же запросом с флагом. У Brave это отдельный тариф и отдельный
   * маршрут, поэтому там картинок нет: провайдер выбран администратором, и
   * молчаливо ходить за него в другой платный маршрут неправильно.
   */
  async searchImages(
    query: string,
    workspaceId: string,
  ): Promise<WebImageResult[]> {
    const settings = await this.settings(workspaceId);
    const driver = settings?.driver || 'searxng';

    if (driver === 'off' || driver === 'brave') return [];

    try {
      if (driver === 'tavily') {
        return await this.imagesFromTavily(query, settings);
      }

      const base = settings?.baseUrl || DEFAULT_SEARXNG_URL;
      const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(
        query,
      )}&format=json&categories=images`;

      const data = await this.fetchJson(url, { method: 'GET' });

      return ((data?.results ?? []) as any[])
        .map((item) => ({
          title: String(item.title ?? ''),
          imageUrl: String(item.img_src ?? ''),
          sourceUrl: String(item.url ?? ''),
        }))
        .filter((item) => item.imageUrl.startsWith('http'))
        .slice(0, IMAGE_LIMIT);
    } catch (err) {
      this.logger.warn(
        `Поиск картинок не отработал: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /**
   * Картинки у Tavily приходят тем же запросом, что и обычная выдача, если
   * попросить их флагом. Описания просим отдельно: без них подпись у картинки
   * взять неоткуда.
   */
  private async imagesFromTavily(
    query: string,
    settings: any,
  ): Promise<WebImageResult[]> {
    if (!settings?.apiKey) return [];

    const data = await this.fetchJson('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: settings.apiKey,
        query,
        max_results: RESULT_LIMIT,
        include_images: true,
        include_image_descriptions: true,
      }),
    });

    // Ответ отдает либо строки с адресами, либо пары адрес и описание.
    return ((data?.images ?? []) as any[])
      .map((item) =>
        typeof item === 'string'
          ? { title: '', imageUrl: item, sourceUrl: '' }
          : {
              title: String(item?.description ?? ''),
              imageUrl: String(item?.url ?? ''),
              sourceUrl: '',
            },
      )
      .filter((item) => item.imageUrl.startsWith('http'))
      .slice(0, IMAGE_LIMIT);
  }

  async search(query: string, workspaceId: string): Promise<WebSearchResult[]> {
    const settings = await this.settings(workspaceId);
    const driver = settings?.driver || 'searxng';

    if (driver === 'off') return [];

    try {
      switch (driver) {
        case 'tavily':
          return await this.searchTavily(query, settings);
        case 'brave':
          return await this.searchBrave(query, settings);
        default:
          return await this.searchSearxng(query, settings);
      }
    } catch (err) {
      // Отказ поиска не должен ронять ответ: агент просто ответит по вики и
      // общим знаниям. Молчать об этом нельзя, поэтому пишем в лог.
      this.logger.warn(
        `Поиск в интернете (${driver}) не отработал: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  private async settings(workspaceId: string): Promise<{
    driver: string | null;
    baseUrl: string | null;
    apiKey: string | null;
  } | null> {
    const row = await this.db
      .selectFrom('workspaceAiSettings')
      .select([
        'webSearchDriver',
        'webSearchBaseUrl',
        'webSearchApiKeyEncrypted',
      ])
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();

    if (!row) return null;

    return {
      driver: row.webSearchDriver ?? null,
      baseUrl: row.webSearchBaseUrl ?? null,
      apiKey: row.webSearchApiKeyEncrypted
        ? decryptSecret(
            row.webSearchApiKeyEncrypted,
            this.environmentService.getAppSecret(),
          )
        : null,
    };
  }


  private async fetchJson(url: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`статус ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private trim(results: WebSearchResult[]): WebSearchResult[] {
    return results
      .filter((item) => item.url && item.title)
      .slice(0, RESULT_LIMIT)
      .map((item) => ({
        ...item,
        snippet: (item.snippet || '').slice(0, SNIPPET_LIMIT),
      }));
  }

  private async searchSearxng(query: string, settings: any) {
    const base = settings?.baseUrl || DEFAULT_SEARXNG_URL;
    const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(
      query,
    )}&format=json`;

    const data = await this.fetchJson(url, { method: 'GET' });

    return this.trim(
      (data?.results ?? []).map((item: any) => ({
        title: String(item.title ?? ''),
        url: String(item.url ?? ''),
        snippet: String(item.content ?? ''),
      })),
    );
  }

  private async searchTavily(query: string, settings: any) {
    if (!settings?.apiKey) return [];

    const data = await this.fetchJson('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: settings.apiKey,
        query,
        max_results: RESULT_LIMIT,
      }),
    });

    return this.trim(
      (data?.results ?? []).map((item: any) => ({
        title: String(item.title ?? ''),
        url: String(item.url ?? ''),
        snippet: String(item.content ?? ''),
      })),
    );
  }

  private async searchBrave(query: string, settings: any) {
    if (!settings?.apiKey) return [];

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
      query,
    )}&count=${RESULT_LIMIT}`;

    const data = await this.fetchJson(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': settings.apiKey,
      },
    });

    return this.trim(
      (data?.web?.results ?? []).map((item: any) => ({
        title: String(item.title ?? ''),
        url: String(item.url ?? ''),
        snippet: String(item.description ?? ''),
      })),
    );
  }
}
