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
