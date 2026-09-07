import { get, post } from '$lib/api/client';

export type Label = { id: string; name: string };

/** Страница перечня и курсор следующей. Пустой курсор означает конец. */
export type Paged<T> = { items: T[]; meta: { nextCursor: string | null } };

/**
 * Метки рабочего пространства. Служит выбору, а не показу на странице.
 *
 * Постранично: на рабочем пространстве с тысячей меток перечень целиком
 * приходил бы в каждом ответе.
 */
export function listLabels(
  values: { cursor?: string; limit?: number } = {},
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  const query = new URLSearchParams();
  if (values.cursor) query.set('cursor', values.cursor);
  if (values.limit) query.set('limit', String(values.limit));
  const tail = query.toString();
  return get<Paged<Label>>(`/api/labels${tail ? `?${tail}` : ''}`, { fetcher, headers });
}

/**
 * Метки самой страницы.
 *
 * Отдельный запрос, а не отбор из списка рабочего пространства: тот перечисляет
 * все заведённые метки, и показ его на странице выдавал бы чужие метки за её
 * собственные.
 */
export function labelsOfPage(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Label[]>('/api/labels/for-page', { pageId }, { fetcher, headers });
}

/** Снять метку со страницы. Сама метка при этом остаётся в пространстве. */
export function detachLabel(pageId: string, labelId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/labels/detach', { pageId, labelId }, { fetcher });
}

/**
 * Привязать метки к странице.
 *
 * Метки передаются именами, а не идентификаторами: несуществующую сервер
 * заводит сам, и требовать от экрана сначала завести метку, а потом привязать,
 * значило бы два запроса там, где хватает одного.
 */
export function attachLabels(pageId: string, names: string[], fetcher?: typeof fetch) {
  return post<Label[]>('/api/labels/attach', { pageId, names }, { fetcher });
}

/** Страница с меткой: то, чем рисуется экран метки. */
export type LabelledPage = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceSlug: string;
  spaceName: string | null;
};

/**
 * Страницы с меткой.
 *
 * Незнакомое имя метки отвечает пустым списком, а не отказом: по разнице
 * ответов иначе перебирается перечень заведённых меток.
 */
export function pagesWithLabel(
  values: { name: string; cursor?: string; limit?: number },
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Paged<LabelledPage>>('/api/labels/pages', values, { fetcher, headers });
}
