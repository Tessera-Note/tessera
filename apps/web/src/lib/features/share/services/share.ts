import { post } from '$lib/api/client';

export type Share = { id: string; key: string; includeSubPages: boolean };

export type SharedPage = {
  id: string;
  slugId: string;
  title: string | null;
  content: unknown;
  updatedAt: string;
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
