import { post } from '$lib/api/client';

export type Notification = {
  id: string;
  type: string;
  actorId: string | null;
  pageId: string | null;
  spaceId: string | null;
  commentId: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
  /** Кто сделал. `null`, если действие завела сама система. */
  actor: { id: string; name: string | null; avatarUrl: string | null } | null;
  /** Страница, к которой ведёт строка. `null`, если её уже удалили. */
  page: { id: string; title: string | null; slugId: string; icon: string | null } | null;
  space: { id: string; name: string | null; slug: string } | null;
};

/** Вкладки списка. Значения из v1: их понимает сервер. */
export type Tab = 'all' | 'direct' | 'updates';

export function listNotifications(
  tab: Tab = 'all',
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Notification[]>('/api/notifications', { tab }, { fetcher, headers });
}

export function unreadCount(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<{ count: number }>('/api/notifications/unread-count', {}, { fetcher, headers });
}

/** Отметить прочитанными. Список, а не одна запись: так их и отмечают — пачкой. */
export function markRead(notificationIds: string[], fetcher?: typeof fetch) {
  return post<{ marked: number }>('/api/notifications/mark-read', { notificationIds }, { fetcher });
}

export function markAllRead(fetcher?: typeof fetch) {
  return post<{ marked: number }>('/api/notifications/mark-all-read', {}, { fetcher });
}
