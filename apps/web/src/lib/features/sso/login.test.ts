/**
 * Вход через провайдера: разбор адресов и решение о самостоятельном переходе.
 *
 * Разметка проверяется отдельно (`SsoLogin.svelte.test.ts`), здесь — правила.
 */

import { describe, expect, it } from 'vitest';
import { autoLogin, loginUrl } from './login';

const oidc = { id: 'p1', name: 'Контора', type: 'oidc' };
const google = { id: 'p2', name: 'Google', type: 'google' };
const ldap = { id: 'p3', name: 'Каталог', type: 'ldap' };

describe('loginUrl', () => {
  it('обычный протокол различает провайдеров путём', () => {
    expect(loginUrl(oidc)).toBe('/api/sso/oidc/p1/login');
  });

  it('у Google идентификатора провайдера в пути нет', () => {
    // Обратный адрес регистрируется в консоли Google один на установку и не
    // может его нести; путь входа тот же, что в v1.
    expect(loginUrl(google)).toBe('/api/sso/google/login');
  });

  it('точка возврата уходит доводом и кодируется', () => {
    expect(loginUrl(oidc, '/s/дизайн/p/1')).toBe(
      '/api/sso/oidc/p1/login?redirect=%2Fs%2F%D0%B4%D0%B8%D0%B7%D0%B0%D0%B9%D0%BD%2Fp%2F1'
    );
  });

  it('пустая точка возврата довода не добавляет', () => {
    expect(loginUrl(oidc, null)).toBe('/api/sso/oidc/p1/login');
  });
});

describe('autoLogin', () => {
  const quiet = { attempted: false, failed: false };

  it('уводит, когда вход через провайдера обязателен и провайдер один', () => {
    expect(autoLogin({ enforceSso: true, authProviders: [oidc] }, quiet)).toEqual(oidc);
  });

  it('не уводит, когда вход через провайдера не обязателен', () => {
    expect(autoLogin({ enforceSso: false, authProviders: [oidc] }, quiet)).toBeNull();
  });

  it('не уводит, когда провайдеров несколько: выбор за человеком', () => {
    expect(autoLogin({ enforceSso: true, authProviders: [oidc, google] }, quiet)).toBeNull();
  });

  it('не уводит к каталогу: у него спрашивают имя и пароль на месте', () => {
    expect(autoLogin({ enforceSso: true, authProviders: [ldap] }, quiet)).toBeNull();
  });

  it('не уводит второй раз подряд', () => {
    // Иначе отказ провайдера закольцевал бы экран входа и не дал бы прочитать
    // причину.
    expect(
      autoLogin({ enforceSso: true, authProviders: [oidc] }, { ...quiet, attempted: true })
    ).toBeNull();
  });

  it('не уводит после отказа провайдера', () => {
    expect(
      autoLogin({ enforceSso: true, authProviders: [oidc] }, { ...quiet, failed: true })
    ).toBeNull();
  });
});
