import { post } from '$lib/api/client';

export type Comment = {
  id: string;
  content: unknown;
  creatorId: string | null;
  /** Имя и картинка автора приходят вместе с комментарием: без них панель
   *  показывала одну дату, и понять, кто что написал, было нельзя. */
  creatorName?: string | null;
  creatorAvatarUrl?: string | null;
  parentCommentId: string | null;
  /** Процитированный кусок страницы. `null` у обсуждения страницы целиком. */
  selection?: string | null;
  resolvedAt: string | null;
  createdAt: string;
  /** На какой странице живёт. Нужно ссылке на отдельную реплику. */
  pageId?: string;
};

export function listComments(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Comment[]>('/api/comments/list', { pageId }, { fetcher, headers });
}

/**
 * Оставить комментарий.
 *
 * Тело комментария это документ редактора, а не строка: так его хранит база, и
 * упоминания внутри него разбирает сервер — по ним он шлёт извещения.
 *
 * `selection` это процитированный кусок страницы. Он хранится строкой рядом с
 * обсуждением, а место в тексте держит метка `comment` в самом документе: текст
 * правят, и хранимые смещения разъехались бы с ним на первой же правке.
 */
export function createComment(
  values: { pageId: string; content: unknown; parentCommentId?: string; selection?: string },
  fetcher?: typeof fetch
) {
  return post<Comment>(
    '/api/comments/create',
    {
      pageId: values.pageId,
      parentCommentId: values.parentCommentId,
      selection: values.selection,
      content: values.content
    },
    { fetcher }
  );
}

/** Править можно только своё: право правки страницы этого не даёт. */
/**
 * Один комментарий.
 *
 * Нужен ссылке на реплику: по идентификатору она узнаёт страницу, на которой
 * реплика живёт. Право проверяется по этой странице, поэтому чужая закрытая
 * реплика отвечает отказом, а не выдаёт название страницы.
 */
export function commentInfo(
  commentId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Comment>('/api/comments/info', { commentId }, { fetcher, headers });
}

export function updateComment(commentId: string, content: unknown, fetcher?: typeof fetch) {
  return post<Comment>('/api/comments/update', { commentId, content }, { fetcher });
}

/** Удалять может автор и тот, кто распоряжается страницей. */
export function deleteComment(commentId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/comments/delete', { commentId }, { fetcher });
}

/** Пометить обсуждение решённым или снять пометку. */
export function resolveComment(commentId: string, resolved: boolean, fetcher?: typeof fetch) {
  return post<Comment>('/api/comments/resolve', { commentId, resolved }, { fetcher });
}
