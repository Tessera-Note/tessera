import { post } from '$lib/api/client';

/** Вид провайдера. Значения из v1: их же понимает сервер. */
export const AI_DRIVERS = ['openai', 'openrouter', 'compatible', 'gemini', 'ollama'] as const;

/** Вид поиска в интернете. `off` означает «выключен». */
export const WEB_SEARCH_DRIVERS = ['off', 'searxng', 'tavily', 'brave'] as const;

/** Что сервер отдаёт администратору. Ключи только масками, целиком их не отдают. */
export type AiSettings = {
  driver: string | null;
  baseUrl: string | null;
  apiKeyPreview: string | null;
  hasApiKey: boolean;
  chatModel: string | null;
  completionModel: string | null;
  embeddingDriver: string | null;
  embeddingBaseUrl: string | null;
  embeddingApiKeyPreview: string | null;
  hasEmbeddingApiKey: boolean;
  embeddingModel: string | null;
  webSearchDriver: string | null;
  webSearchBaseUrl: string | null;
  hasWebSearchApiKey: boolean;
  /** Что применяется на самом деле, с учётом настроек из окружения. */
  resolved: {
    driver: string | null;
    chatModel: string | null;
    completionModel: string | null;
    usable: boolean;
    fromEnvironment: boolean;
    embeddingDriver: string | null;
    embeddingModel: string | null;
    embeddingUsable: boolean;
  };
};

/**
 * Частичное обновление.
 *
 * Пропущенное поле сервер не трогает, пустая строка стирает. Поэтому отправлять
 * надо только то, что человек менял: полная форма при каждом сохранении стёрла
 * бы ключ, которого в ней нет.
 */
export type AiPatch = Partial<{
  driver: string;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  completionModel: string;
  embeddingDriver: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  webSearchDriver: string;
  webSearchBaseUrl: string;
  webSearchApiKey: string;
}>;

export function aiSettings(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<AiSettings>('/api/ai/settings', {}, { fetcher, headers });
}

export function updateAiSettings(values: AiPatch, fetcher?: typeof fetch) {
  return post<AiSettings & { reindexScheduled: boolean }>('/api/ai/settings/update', values, {
    fetcher
  });
}

/** Убрать свои настройки и вернуться к конфигурации из окружения. */
export function resetAiSettings(fetcher?: typeof fetch) {
  return post<AiSettings>('/api/ai/settings/reset', {}, { fetcher });
}
