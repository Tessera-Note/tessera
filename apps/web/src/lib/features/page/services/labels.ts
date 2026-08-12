import { get, post } from '$lib/api/client';

export type Label = { id: string; name: string };

export function listLabels(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<Label[]>('/api/labels', { fetcher, headers });
}

/**
 * Привязать метки к странице.
 *
 * Метки передаются именами, а не идентификаторами: несуществующую сервер
 * заводит сам, и требовать от экрана сначала завести метку, а потом привязать,
 * значило бы два запроса там, где хватает одного.
 */
export function attachLabels(pageId: string, names: string[], fetcher?: typeof fetch) {
  return post<Label[]>('/api/labels/attach', { pageId, names }, { fetcher });
}
