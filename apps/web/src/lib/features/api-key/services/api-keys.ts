import { post } from '$lib/api/client';

export type ApiKey = {
  id: string;
  name: string;
  creatorId?: string;
  /** Кто завёл ключ. Пусто, если запись владельца удалена. */
  creator?: { id: string; name: string | null; email: string } | null;
  expiresAt: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
};

/** Ответ на создание. Значение ключа приходит один раз и больше нигде не хранится. */
export type CreatedApiKey = ApiKey & { token: string };

/**
 * Ключи человека, а администратору — по желанию все.
 *
 * Признак передаётся серверу, а не решается на клиенте: список чужих ключей
 * отдаётся только администратору, и отбор в разметке ничего бы не закрыл.
 */
export function listApiKeys(
  adminView = false,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<{ items: ApiKey[]; meta: { nextCursor: string | null } }>(
    '/api/api-keys',
    { adminView },
    { fetcher, headers }
  );
}

export function createApiKey(
  values: { name: string; expiresAt?: string | null },
  fetcher?: typeof fetch
) {
  return post<CreatedApiKey>('/api/api-keys/create', values, { fetcher });
}

export function renameApiKey(apiKeyId: string, name: string, fetcher?: typeof fetch) {
  return post<ApiKey>('/api/api-keys/update', { apiKeyId, name }, { fetcher });
}

export function revokeApiKey(apiKeyId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/api-keys/revoke', { apiKeyId }, { fetcher });
}
