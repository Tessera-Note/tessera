import { post } from '$lib/api/client';

export type Comment = {
  id: string;
  content: unknown;
  creatorId: string | null;
  parentCommentId: string | null;
  resolvedAt: string | null;
  createdAt: string;
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
 * упоминания внутри него разбирает сервер. Простой текст оборачивается в
 * абзац — единственный узел, который здесь нужен до появления редактора.
 */
export function createComment(
  values: { pageId: string; text: string; parentCommentId?: string },
  fetcher?: typeof fetch
) {
  return post<Comment>(
    '/api/comments/create',
    {
      pageId: values.pageId,
      parentCommentId: values.parentCommentId,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: values.text }] }]
      }
    },
    { fetcher }
  );
}

/** Тело комментария документом редактора: так его хранит база. */
function document(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  };
}

/** Править можно только своё: право правки страницы этого не даёт. */
export function updateComment(commentId: string, text: string, fetcher?: typeof fetch) {
  return post<Comment>('/api/comments/update', { commentId, content: document(text) }, { fetcher });
}

/** Удалять может автор и тот, кто распоряжается страницей. */
export function deleteComment(commentId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/comments/delete', { commentId }, { fetcher });
}

/** Пометить обсуждение решённым или снять пометку. */
export function resolveComment(commentId: string, resolved: boolean, fetcher?: typeof fetch) {
  return post<Comment>('/api/comments/resolve', { commentId, resolved }, { fetcher });
}
