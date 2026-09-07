import { post } from '$lib/api/client';

export type Backlink = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceId: string;
};

/**
 * Страницы, ссылающиеся на эту.
 *
 * Выдача отфильтрована сервером по правам: обратная ссылка раскрывает название
 * и адрес источника, а источник бывает в закрытой ветви.
 */
export function backlinksOf(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Backlink[]>('/api/pages/backlinks', { pageId }, { fetcher, headers });
}

/**
 * Сколько страниц ссылается сюда.
 *
 * Отдельно от перечня: со страницей идёт только счёт — его хватает, чтобы
 * подписать вкладку, — а сам перечень грузится, когда вкладку открыли. Считает
 * сервер по тому же отбору прав, что и перечень, поэтому число сходится с
 * видимыми строками.
 */
export function backlinksCount(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<{ count: number }>('/api/pages/backlinks-count', { pageId }, { fetcher, headers });
}
