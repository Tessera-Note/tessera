import { post } from '$lib/api/client';

export type PageSummary = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  parentPageId: string | null;
  spaceId: string;
  hasChildren?: boolean;
};

export type PageBody = PageSummary & {
  content: unknown;
  canEdit?: boolean;
  restricted?: boolean;
  updatedAt?: string;
};

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
