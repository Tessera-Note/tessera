/**
 * Названия событий журнала.
 *
 * Журнал показывал коды, и каждая строка читалась как запись в лог. Здесь
 * проверяется само отображение и его запасной путь: журнал пополняется новыми
 * событиями, и код без подписи обязан остаться видимым.
 */

import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_LABELS, eventLabel } from './labels';

describe('eventLabel', () => {
  it('известный код становится названием', () => {
    expect(eventLabel('user.logged_in')).toBe('Logged in');
    expect(eventLabel('space.deleted')).toBe('Deleted space');
  });

  it('неизвестный код показывается кодом', () => {
    // Пустая строка вместо кода скрыла бы событие целиком.
    expect(eventLabel('page.something_new')).toBe('page.something_new');
    expect(eventLabel('')).toBe('');
  });

  it('подписи заведены на все события приложения', () => {
    // Перечень взят из `AuditEvent` приложения. Расхождение означает событие,
    // которое человек увидит кодом.
    const known = [
      'workspace.created',
      'workspace.updated',
      'workspace.invite_resent',
      'user.invited',
      'user.invite_accepted',
      'user.deleted',
      'user.logged_in',
      'user.logged_out',
      'user.role_changed',
      'user.password_changed',
      'user.deactivated',
      'user.activated',
      'user.sso_unlinked',
      'mfa.enabled',
      'mfa.disabled',
      'mfa.reset',
      'api_key.created',
      'api_key.updated',
      'api_key.deleted',
      'scim_token.created',
      'scim_token.updated',
      'scim_token.deleted',
      'space.created',
      'space.updated',
      'space.deleted',
      'space.member_added',
      'space.member_removed',
      'space.member_role_changed',
      'space.exported',
      'group.created',
      'group.updated',
      'group.deleted',
      'group.member_added',
      'group.member_removed',
      'page.imported',
      'page.exported',
      'sso.provider_created',
      'sso.provider_updated',
      'sso.provider_deleted'
    ];

    expect(known.filter((one) => !(one in AUDIT_EVENT_LABELS))).toEqual([]);
  });
});
