import { post } from '$lib/api/client';

export type SearchHit = {
  id: string;
  slugId: string;
  title: string | null;
  spaceId: string;
  /** Отрывок с подсветкой. Приходит размеченным сервером, а не собирается тут. */
  highlight: string | null;
  rank: number;
};

/**
 * Поиск по страницам.
 *
 * Пространство необязательно: без него ищется по всем доступным. Отбор по
 * правам делает сервер, и повторять его здесь нельзя — разойдясь, второй отбор
 * либо спрячет доступное, либо покажет закрытое.
 */
export function searchPages(
  query: string,
  spaceId?: string | null,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<SearchHit[]>(
    '/api/search',
    { query, spaceId: spaceId || undefined },
    { fetcher, headers }
  );
}
