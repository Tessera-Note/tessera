import { post } from '$lib/api/client';

/**
 * Провайдеры моделей. Значения понимает сервер, подписи видит человек.
 *
 * Пустое значение не «не выбрано», а «жить по настройке из окружения»: сервер
 * пустую строку принимает и стирает ею свою настройку.
 */
export const AI_DRIVERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'ollama', label: 'Ollama (self-hosted)' },
  { value: 'openai-compatible', label: 'OpenAI-compatible endpoint' }
] as const;

/**
 * Поиск в интернете.
 *
 * Пустое значение означает свой сервис рядом в развёртывании, то есть поиск
 * включён. Выключает его только `off` — путать эти два значения нельзя, иначе
 * подпись обещает обратное тому, что произойдёт.
 */
export const WEB_SEARCH_DRIVERS = [
  { value: 'searxng', label: 'Bundled search service (no key needed)' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'brave', label: 'Brave Search' },
  { value: 'off', label: 'Disabled' }
] as const;

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

export type AiModel = { id: string; label: string };

/**
 * Перечень моделей у провайдера.
 *
 * Переданные ключ и адрес перекрывают сохранённые: перечень спрашивается до
 * сохранения, по только что введённым значениям. Иначе выбрать модель у нового
 * провайдера нельзя — сначала сохрани вслепую, потом смотри, что там есть.
 */
export function aiModels(
  values: { driver?: string; baseUrl?: string; apiKey?: string; kind?: 'chat' | 'embedding' },
  fetcher?: typeof fetch
) {
  return post<{ models: AiModel[] }>('/api/ai/settings/models', values, { fetcher });
}

/** Проверить соединение с провайдером. Отвечает исходом, а не отказом. */
export function testAiConnection(fetcher?: typeof fetch) {
  return post<{ ok: boolean; message: string }>('/api/ai/settings/test', {}, { fetcher });
}

/** Убрать свои настройки и вернуться к конфигурации из окружения. */
export function resetAiSettings(fetcher?: typeof fetch) {
  return post<AiSettings>('/api/ai/settings/reset', {}, { fetcher });
}
