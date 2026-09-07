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
  /** База, а не обычная страница: у неё свой значок и свой экран. */
  isBase?: boolean;
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

/**
 * Отметка избранного вместе с пространством.
 *
 * Полей меньше, чем у страницы: у пространства нет ни ветви, ни значка, а
 * короткое имя и есть адрес.
 */
export type FavoriteSpace = {
  id: string;
  spaceId: string;
  type: string;
  name: string | null;
  slug: string;
};

/**
 * Только идентификаторы отмеченных страниц.
 *
 * Дереву нужна одна вещь: закрашивать ли звезду у строки. Полный перечень с
 * названиями ради этого — лишний обход прав на каждую строку и лишний объём на
 * каждое открытие пространства.
 */
export function favoritePageIds(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<string[]>('/api/favorites/ids', { fetcher, headers });
}

export function listFavoriteSpaces(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<FavoriteSpace[]>('/api/favorites/spaces', { fetcher, headers });
}

/**
 * Отметить пространство и снять отметку.
 *
 * Вид передаётся полем `type`: маршрут на сервере один на все виды отметок, и
 * без вида он считает отметку страничной.
 */
export function addFavoriteSpace(spaceId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/favorites/add', { type: 'space', spaceId }, { fetcher });
}

export function removeFavoriteSpace(spaceId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/favorites/remove', { type: 'space', spaceId }, { fetcher });
}

/**
 * Отмеченный шаблон.
 *
 * Полей меньше, чем у страницы: у шаблона нет ни ветви, ни короткого имени в
 * адресе — он открывается по идентификатору.
 */
export type FavoriteTemplate = {
  id: string;
  templateId: string;
  type: string;
  title: string | null;
  icon: string | null;
  spaceId: string | null;
};

export function listFavoriteTemplates(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<FavoriteTemplate[]>('/api/favorites/templates', { fetcher, headers });
}

export function addFavoriteTemplate(templateId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>(
    '/api/favorites/add',
    { type: 'template', templateId },
    { fetcher }
  );
}

export function removeFavoriteTemplate(templateId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>(
    '/api/favorites/remove',
    { type: 'template', templateId },
    { fetcher }
  );
}
