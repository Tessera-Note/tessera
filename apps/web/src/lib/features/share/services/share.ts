import { post } from '$lib/api/client';

export type Share = {
  id: string;
  key: string;
  includeSubPages: boolean;
  /** Отдавать ли страницу поисковым машинам. По умолчанию нет. */
  searchIndexing?: boolean;
};

/** Страница дерева опубликованной ветви. */
export type SharedTreeItem = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  parentPageId: string | null;
  position: string | null;
};

export type SharedHit = {
  id: string;
  slugId: string;
  title: string | null;
  highlight: string | null;
};

export type SharedPage = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  content: unknown;
  updatedAt: string;
  share: Share & { pageId: string };
};

export function createShare(
  values: { pageId: string; includeSubPages?: boolean; searchIndexing?: boolean },
  fetcher?: typeof fetch
) {
  return post<Share>('/api/share/create', values, { fetcher });
}

/**
 * Действующая ссылка страницы или `null`, если её нет.
 *
 * Читателю это тоже отвечают: видеть, что страница отдаётся наружу, полагается
 * каждому, кто её читает.
 */
export function shareForPage(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Share | null>('/api/share/for-page', { pageId }, { fetcher, headers });
}

/**
 * Изменить настройки ссылки.
 *
 * Право то же, что у заведения: распространить ссылку на подстраницы значит
 * открыть наружу то, чего в исходной ссылке не было.
 */
export function updateShare(
  shareId: string,
  values: { includeSubPages?: boolean; searchIndexing?: boolean },
  fetcher?: typeof fetch
) {
  return post<Share>('/api/share/update', { shareId, ...values }, { fetcher });
}

export function revokeShare(pageId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/share/revoke', { pageId }, { fetcher });
}

/**
 * Открыть страницу по ключу ссылки.
 *
 * Вход не нужен: ссылка и заводится ради тех, у кого учётной записи нет.
 * Учётными данными служит сам ключ.
 */
export function openShared(
  key: string,
  pageId?: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<SharedPage>('/api/share/open', { key, pageId }, { fetcher, headers });
}

/** Дерево опубликованной ветви. Вход не нужен: отбор задаёт ключ. */
export function sharedTree(key: string, fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<{ share: Share; rootId: string; pageTree: SharedTreeItem[] }>(
    '/api/share/tree',
    { key },
    { fetcher, headers }
  );
}

/** Поиск внутри опубликованной ветви. За её пределы не выходит. */
export function searchShared(key: string, query: string, fetcher?: typeof fetch) {
  return post<SharedHit[]>('/api/share/search', { key, query }, { fetcher });
}
