import { post } from '$lib/api/client';

export type ScimToken = {
  id: string;
  name: string;
  /** Четыре последних знака: по ним токен опознают в списке. Значения нет. */
  lastFour: string;
  isEnabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
};

/** Ответ на создание. Значение приходит один раз и больше нигде не хранится. */
export type CreatedScimToken = { id: string; name: string; lastFour: string; token: string };

export function listScimTokens(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<ScimToken[]>('/api/scim-tokens', {}, { fetcher, headers });
}

export function createScimToken(name: string, fetcher?: typeof fetch) {
  return post<CreatedScimToken>('/api/scim-tokens/create', { name }, { fetcher });
}

export function renameScimToken(tokenId: string, name: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/scim-tokens/update', { tokenId, name }, { fetcher });
}

export function revokeScimToken(tokenId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/scim-tokens/revoke', { tokenId }, { fetcher });
}
