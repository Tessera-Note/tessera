import type { Notification } from './services/notifications';

/**
 * Ключ словаря по виду уведомления.
 *
 * Ключи взяты из v1 дословно: словари общие, и своя формулировка означала бы
 * двенадцать непереведённых строк в одиннадцати языках.
 */
export function messageKey(notification: Notification): string {
  switch (notification.type) {
    case 'comment.user_mention':
      return '<bold>{{name}}</bold> mentioned you in a comment';
    case 'comment.created':
      return '<bold>{{name}}</bold> commented on a page';
    case 'comment.resolved':
      return '<bold>{{name}}</bold> resolved a comment';
    case 'page.user_mention':
      return '<bold>{{name}}</bold> mentioned you on a page';
    case 'page.permission_granted':
      return notification.data?.role === 'writer'
        ? '<bold>{{name}}</bold> gave you edit access to a page'
        : '<bold>{{name}}</bold> gave you view access to a page';
    case 'page.updated':
      return '<bold>{{name}}</bold> updated a page';
    case 'page.verified':
      return '<bold>{{name}}</bold> verified a page';
    case 'page.approval_requested':
      return '<bold>{{name}}</bold> submitted a page for your approval';
    case 'page.approval_rejected':
      return '<bold>{{name}}</bold> returned a page for revision';
    case 'page.verification_expiring':
      return 'Page verification expires soon';
    case 'page.verification_expired':
      return 'Page verification has expired';
    default:
      return '';
  }
}

/**
 * Разбор строки с `<bold>…</bold>` на три части.
 *
 * Вставлять её как разметку нельзя: внутрь подставляется имя человека, то есть
 * произвольный текст из базы. Три части рисуются обычными узлами, и имя
 * остаётся текстом при любом содержимом.
 */
export function splitBold(text: string): [string, string, string] {
  const open = text.indexOf('<bold>');
  const close = text.indexOf('</bold>');
  if (open === -1 || close === -1 || close < open) return [text, '', ''];
  return [
    text.slice(0, open),
    text.slice(open + '<bold>'.length, close),
    text.slice(close + '</bold>'.length)
  ];
}
