/**
 * Названия событий журнала.
 *
 * Журнал показывал коды — `user.logged_in`, `space.deleted`, — и каждая строка
 * читалась как запись в лог. Подписи взяты из v1
 * (`ee/audit/lib/audit-event-labels.ts`); коды, которых в v1 нет, названы по
 * тому же образцу: действие в прошедшем времени и предмет.
 *
 * Неизвестный код отдаётся как есть: журнал пополняется новыми событиями, и
 * пустая строка вместо кода скрыла бы событие целиком.
 */
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  'workspace.created': 'Created workspace',
  'workspace.updated': 'Updated workspace',
  'workspace.invite_resent': 'Resent invitation',

  'user.invited': 'Created invitation',
  'user.invite_accepted': 'Accepted invitation',
  'user.deleted': 'Deleted member',
  'user.logged_in': 'Logged in',
  'user.logged_out': 'Logged out',
  'user.role_changed': 'Changed user role',
  'user.password_changed': 'Changed password',
  'user.deactivated': 'Deactivated user',
  'user.activated': 'Activated user',
  'user.sso_unlinked': 'Removed sign-in provider link',

  'mfa.enabled': 'Enabled MFA',
  'mfa.disabled': 'Disabled MFA',
  'mfa.reset': 'Reset MFA for member',

  'api_key.created': 'Created API key',
  'api_key.updated': 'Updated API key',
  'api_key.deleted': 'Deleted API key',

  'scim_token.created': 'Created SCIM token',
  'scim_token.updated': 'Updated SCIM token',
  'scim_token.deleted': 'Deleted SCIM token',

  'space.created': 'Created space',
  'space.updated': 'Updated space',
  'space.deleted': 'Deleted space',
  'space.member_added': 'Added space member',
  'space.member_removed': 'Removed space member',
  'space.member_role_changed': 'Changed space member role',
  'space.exported': 'Exported space',

  'group.created': 'Created group',
  'group.updated': 'Updated group',
  'group.deleted': 'Deleted group',
  'group.member_added': 'Added group member',
  'group.member_removed': 'Removed group member',

  'page.imported': 'Imported page',
  'page.exported': 'Exported page',

  'sso.provider_created': 'Created SSO provider',
  'sso.provider_updated': 'Updated SSO provider',
  'sso.provider_deleted': 'Deleted SSO provider'
};

/** Подпись события. Неизвестный код показывается кодом. */
export function eventLabel(event: string): string {
  return AUDIT_EVENT_LABELS[event] ?? event;
}
