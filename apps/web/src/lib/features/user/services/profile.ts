import { post } from '$lib/api/client';
import type { User } from '$lib/api/session';

/**
 * Правка своей учётной записи.
 *
 * Поле, которого нет в запросе, сервер не трогает: экран шлёт то, что человек
 * менял, и передача пустых значений стирала бы имя при смене языка.
 */
export type ProfilePatch = {
  name?: string;
  locale?: string;
  fullPageWidth?: boolean;
  pageEditMode?: string;
  editorToolbar?: boolean;
  notificationPageUpdates?: boolean;
  notificationPageUserMention?: boolean;
  notificationCommentUserMention?: boolean;
  notificationCommentCreated?: boolean;
  notificationCommentResolved?: boolean;
  notificationPagePermissionGranted?: boolean;
  notificationPageApprovalRequested?: boolean;
  notificationPageVerificationUpdates?: boolean;
};

export function updateProfile(values: ProfilePatch, fetcher?: typeof fetch) {
  return post<User>('/api/users/update', values, { fetcher });
}

/**
 * Переключатели уведомлений: поле запроса, ключ хранения и подпись.
 *
 * Ключ хранения записан так, как его пишет v1: база одна на обе версии.
 * Отсутствие ключа означает согласие — настройки заводятся при первом отказе.
 */
export const NOTIFICATION_SWITCHES = [
  {
    field: 'notificationPageUpdates',
    key: 'page.updated',
    label: 'Page updates',
    hint: 'Get notified when a page you watch is updated.'
  },
  {
    field: 'notificationPageUserMention',
    key: 'page.userMention',
    label: 'Page mentions',
    hint: 'Get notified when someone mentions you on a page.'
  },
  {
    field: 'notificationCommentUserMention',
    key: 'comment.userMention',
    label: 'Comment mentions',
    hint: 'Get notified when someone mentions you in a comment.'
  },
  {
    field: 'notificationCommentCreated',
    key: 'comment.created',
    label: 'New comments',
    hint: 'Get notified about new comments on pages you watch.'
  },
  {
    field: 'notificationCommentResolved',
    key: 'comment.resolved',
    label: 'Resolved comments',
    hint: 'Get notified when a comment thread is resolved.'
  },
  {
    field: 'notificationPagePermissionGranted',
    key: 'page.permissionGranted',
    label: 'Page access',
    hint: 'Get notified when you are given access to a page.'
  },
  {
    field: 'notificationPageApprovalRequested',
    key: 'page.approvalRequested',
    label: 'Approval requests',
    hint: 'Get notified when a page is submitted for your approval.'
  },
  {
    field: 'notificationPageVerificationUpdates',
    key: 'page.verificationUpdates',
    label: 'Page verification',
    hint: 'Get notified about verification and approval changes.'
  }
] as const;
