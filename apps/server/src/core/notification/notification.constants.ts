export const NotificationType = {
  COMMENT_USER_MENTION: 'comment.user_mention',
  COMMENT_CREATED: 'comment.created',
  COMMENT_RESOLVED: 'comment.resolved',
  PAGE_USER_MENTION: 'page.user_mention',
  PAGE_PERMISSION_GRANTED: 'page.permission_granted',
  PAGE_UPDATED: 'page.updated',
  PAGE_VERIFICATION_EXPIRING: 'page.verification_expiring',
  PAGE_VERIFICATION_EXPIRED: 'page.verification_expired',
  PAGE_VERIFIED: 'page.verified',
  PAGE_APPROVAL_REQUESTED: 'page.approval_requested',
  PAGE_APPROVAL_REJECTED: 'page.approval_rejected',
} as const;

export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];

export type NotificationSettingKey =
  | 'page.updated'
  | 'page.userMention'
  | 'page.permissionGranted'
  | 'page.approvalRequested'
  | 'page.verificationUpdates'
  | 'comment.userMention'
  | 'comment.created'
  | 'comment.resolved';

/**
 * Соответствие вида уведомления выключателю в настройках.
 *
 * Выключателей меньше, чем видов, и это осознанно: человек различает не виды,
 * а поводы. Просьба об утверждении требует действия и мутится отдельно, потому
 * что молчать о ней дороже всего. Подтверждение, отказ и оба срока это исходы
 * и сроки одного и того же процесса проверки, их различать в настройках незачем.
 *
 * Вид без выключателя письмом не управляется вовсе: `queueEmail` без типа
 * настройку не спрашивает, и отказаться от такого письма нельзя.
 */
export const NotificationTypeToSettingKey: Partial<
  Record<NotificationType, NotificationSettingKey>
> = {
  [NotificationType.PAGE_UPDATED]: 'page.updated',
  [NotificationType.PAGE_USER_MENTION]: 'page.userMention',
  [NotificationType.PAGE_PERMISSION_GRANTED]: 'page.permissionGranted',
  [NotificationType.PAGE_APPROVAL_REQUESTED]: 'page.approvalRequested',
  [NotificationType.PAGE_APPROVAL_REJECTED]: 'page.verificationUpdates',
  [NotificationType.PAGE_VERIFIED]: 'page.verificationUpdates',
  [NotificationType.PAGE_VERIFICATION_EXPIRING]: 'page.verificationUpdates',
  [NotificationType.PAGE_VERIFICATION_EXPIRED]: 'page.verificationUpdates',
  [NotificationType.COMMENT_USER_MENTION]: 'comment.userMention',
  [NotificationType.COMMENT_CREATED]: 'comment.created',
  [NotificationType.COMMENT_RESOLVED]: 'comment.resolved',
};

export type NotificationTab = 'direct' | 'updates' | 'all';

export const DIRECT_NOTIFICATION_TYPES: NotificationType[] = [
  NotificationType.COMMENT_USER_MENTION,
  NotificationType.COMMENT_CREATED,
  NotificationType.COMMENT_RESOLVED,
  NotificationType.PAGE_USER_MENTION,
  NotificationType.PAGE_PERMISSION_GRANTED,
  // Верификация адресована конкретному человеку и ждет от него действия,
  // поэтому вкладка та же, что у упоминания, а не лента обновлений. Раньше
  // разницы не было: эти уведомления не создавались вовсе.
  NotificationType.PAGE_VERIFIED,
  NotificationType.PAGE_APPROVAL_REQUESTED,
  NotificationType.PAGE_APPROVAL_REJECTED,
  NotificationType.PAGE_VERIFICATION_EXPIRING,
  NotificationType.PAGE_VERIFICATION_EXPIRED,
];

export const UPDATES_NOTIFICATION_TYPES: NotificationType[] = [
  NotificationType.PAGE_UPDATED,
];

export function getTypesForTab(tab: NotificationTab): NotificationType[] | undefined {
  if (tab === 'direct') return DIRECT_NOTIFICATION_TYPES;
  if (tab === 'updates') return UPDATES_NOTIFICATION_TYPES;
  return undefined;
}
