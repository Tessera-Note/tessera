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
  /** Кто открыл страницу наружу. Пусто, если учётной записи уже нет. */
  creatorName: string | null;
  creatorAvatarUrl: string | null;
};

/** Страница перечня и курсор следующей. Пустой курсор означает конец. */
export type SharePage = { items: ShareRow[]; meta: { nextCursor: string | null } };

/**
 * Ссылки в пространствах, где человек состоит.
 *
 * Не свои, а все доступные: экран открывают ради вопроса «что из нашего сейчас
 * открыто наружу», и ссылку мог завести любой, кто вправе править страницу.
 *
 * Постранично: открытых страниц бывают сотни, и перечень целиком приходил бы
 * в каждом ответе экрана.
 */
export function listShares(
  values: { cursor?: string; limit?: number } = {},
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<SharePage>('/api/share/', values, { fetcher, headers });
}
