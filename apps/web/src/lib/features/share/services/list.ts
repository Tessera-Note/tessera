import { post } from '$lib/api/client';

/** Действующая ссылка вместе со страницей и пространством. */
export type ShareRow = {
  id: string;
  key: string;
  includeSubPages: boolean;
  searchIndexing: boolean;
  createdAt: string;
  pageId: string;
  pageTitle: string | null;
  pageSlugId: string;
  spaceSlug: string;
  spaceName: string | null;
};

/**
 * Ссылки в пространствах, где человек состоит.
 *
 * Не свои, а все доступные: экран открывают ради вопроса «что из нашего сейчас
 * открыто наружу», и ссылку мог завести любой, кто вправе править страницу.
 */
export function listShares(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<ShareRow[]>('/api/share/', {}, { fetcher, headers });
}
