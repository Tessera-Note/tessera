import { get, post } from '$lib/api/client';

export type Favorite = { id: string; pageId: string; type: string };

export function listFavorites(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<Favorite[]>('/api/favorites', { fetcher, headers });
}

export function addFavorite(pageId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/favorites/add', { pageId }, { fetcher });
}

export function removeFavorite(pageId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/favorites/remove', { pageId }, { fetcher });
}
