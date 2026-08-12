/**
 * Обращения к серверу.
 *
 * Компонент сюда не ходит: порядок из v1 переносится целиком —
 * `features/<домен>/types`, затем `services`, затем `queries`, и только потом
 * разметка. Прямой вызов из компонента разносит обработку отказов и
 * инвалидацию кеша по сорока местам.
 *
 * **Отказ разбирается по коду, а не по тексту.** Сервер отдаёт `{code,
 * message, params}`, клиент переводит по коду. Показывать `message` значит
 * показывать английский текст человеку с любой из двенадцати локалей — ровно
 * тот дефект, который в v1 чинили заменой сообщений на коды.
 */

import { apiBase } from '$lib/api/base';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params: Record<string, string | number>;

  constructor(status: number, code: string, message: string, params: Record<string, string | number>) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.params = params;
  }

  /** Вход потерян: сессия отозвана, истекла или её не было. */
  get unauthenticated(): boolean {
    return this.status === 401;
  }
}

type Options = {
  method?: string;
  body?: unknown;
  /** Заголовки запроса. Нужны на сервере: там куки не подставляются сами. */
  headers?: Record<string, string>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

/**
 * Один запрос к серверу.
 *
 * `credentials: 'include'` обязателен: вход держится в куке, и без него
 * каждый запрос уходит без неё, а сервер отвечает отказом входа. Заметно это
 * не сразу — часть маршрутов открыта.
 */
export async function request<T>(path: string, options: Options = {}): Promise<T> {
  const call = options.fetcher ?? fetch;
  const method = options.method ?? 'GET';

  const response = await call(`${apiBase()}${path}`, {
    method,
    credentials: 'include',
    signal: options.signal,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // Тело не разобралось. Для отказа это не важно, для успеха означает,
      // что отвечает не наш сервер, а что-то на его месте.
      payload = null;
    }
  }

  if (!response.ok) {
    const body = (payload ?? {}) as {
      code?: string;
      message?: string;
      params?: Record<string, string | number>;
      detail?: string;
    };
    throw new ApiError(
      response.status,
      body.code ?? 'error.common.unknown',
      body.message ?? body.detail ?? '',
      body.params ?? {}
    );
  }

  return payload as T;
}

export function post<T>(path: string, body?: unknown, options: Options = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body: body ?? {} });
}

export function get<T>(path: string, options: Options = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'GET' });
}
