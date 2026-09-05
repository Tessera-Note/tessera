import { get, post } from '$lib/api/client';

/**
 * Отметка избранного вместе со страницей.
 *
 * Название и адрес приходят рядом с идентификатором: экрану избранного иначе
 * пришлось бы запрашивать каждую страницу отдельно. Страницы, к которым доступ
 * снят, сервер в список не отдаёт вовсе.
 */
export type Favorite = {
  id: string;
  pageId: string;
  type: string;
  title: string | null;
  slugId: string;
  icon: string | null;
  spaceId: string;
  spaceSlug: string;
  spaceName: string | null;
};

export function listFavorites(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<Favorite[]>('/api/favorites', { fetcher, headers });
}

export function addFavorite(pageId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/favorites/add', { pageId }, { fetcher });
}

export function removeFavorite(pageId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/favorites/remove', { pageId }, { fetcher });
}
