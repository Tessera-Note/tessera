import { Reflector } from '@nestjs/core';

/** Библиотека эти имена наружу не отдает, а декоратор пишет метаданные ими. */
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';
import { LdapController } from '../../ee/sso/ldap.controller';
import { LDAP_LOGIN_THROTTLER } from './throttler-names';
import { THROTTLERS } from './throttle.module';

/**
 * Любой `ThrottlerGuard` проверяет все объявленные счетчики, кроме явно
 * пропущенных. Пока порог входа через каталог стоял в общей настройке, он
 * молча ограничивал двенадцать контроллеров: чат, ИИ, MCP, экспорт, SSO, MFA
 * и вход. Открытие чата тратило пять запросов и получало отказ на пять минут.
 */
describe('порог входа через каталог задан на маршруте', () => {
  const reflector = new Reflector();
  const login = LdapController.prototype.login;

  it('порог висит на самом маршруте входа', () => {
    const limit = reflector.get(
      `${THROTTLER_LIMIT}${LDAP_LOGIN_THROTTLER}`,
      login,
    );

    expect(limit).toBe(5);
  });

  it('окно тоже задано на маршруте', () => {
    const ttl = reflector.get(`${THROTTLER_TTL}${LDAP_LOGIN_THROTTLER}`, login);

    expect(ttl).toBe(300_000);
  });

  /**
   * Свободное значение в общей настройке безопаснее списка исключений на
   * каждом контроллере: следующий контроллер не обязан помнить про чужой
   * счетчик.
   *
   * Значение берется настоящей константой, а не разбором текста модуля: разбор
   * подтверждает написание, а не то, с чем поднимется приложение.
   */
  it('в общей настройке порог свободный', () => {
    const declared = THROTTLERS.find(
      (throttler) => throttler.name === LDAP_LOGIN_THROTTLER,
    );

    expect(declared).toBeDefined();
    expect(declared.limit).toBeGreaterThan(1000);
  });
});
