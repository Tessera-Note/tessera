import { post } from '$lib/api/client';

export type PageSummary = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  parentPageId: string | null;
  spaceId: string;
};

export type PageBody = PageSummary & {
  content: unknown;
  canEdit?: boolean;
  restricted?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type Crumb = { id: string; slugId: string; title: string | null; icon: string | null };

/** Ветвь дерева. Пустой родитель означает корень пространства. */
export function pageTree(
  spaceId: string,
  parentPageId: string | null,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<PageSummary[]>('/api/pages/tree', { spaceId, parentPageId }, { fetcher, headers });
}

export function pageInfo(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<PageBody>('/api/pages/info', { pageId }, { fetcher, headers });
}

export function breadcrumbs(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Crumb[]>('/api/pages/breadcrumbs', { pageId }, { fetcher, headers });
}

export function createPage(
  values: { spaceId: string; title?: string; parentPageId?: string | null },
  fetcher?: typeof fetch
) {
  return post<{ id: string; slugId: string; title: string | null }>(
    '/api/pages/create',
    values,
    { fetcher }
  );
}

/**
 * Изменить страницу.
 *
 * Содержимое здесь не передаётся: его правит совместное редактирование, и
 * отправка тела обычным запросом затирала бы правки, которых этот экран не
 * видел. Через этот путь идут только название и значок.
 */
export function updatePage(
  values: { pageId: string; title?: string; icon?: string },
  fetcher?: typeof fetch
) {
  return post<PageBody>('/api/pages/update', values, { fetcher });
}

export function deletePage(pageId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/pages/delete', { pageId }, { fetcher });
}

export function restorePage(pageId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/pages/restore', { pageId }, { fetcher });
}
