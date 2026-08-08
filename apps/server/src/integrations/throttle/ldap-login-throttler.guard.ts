import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

type LdapLoginRequest = {
  params?: { providerId?: string };
  body?: { username?: unknown };
};

/**
 * Счетчик попыток входа через каталог по паре провайдера и имени.
 *
 * Обычный счетчик считает по адресу запроса. За корпоративным NAT этого мало
 * в обе стороны: сотрудники делят один адрес и мешают друг другу, а перебор
 * пароля одного человека с разных адресов лимита не встречает вовсе. Перебор
 * через нас при этом накручивает счетчик неудач в самом каталоге и блокирует
 * настоящую учетную запись, то есть превращается в способ отключить
 * сотрудника, не зная его пароля.
 *
 * Имя пользователя приводится к нижнему регистру: каталоги в большинстве
 * своем нечувствительны к регистру, и без приведения счетчик обходился бы
 * сменой заглавной буквы.
 */
@Injectable()
export class LdapLoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: LdapLoginRequest): Promise<string> {
    const providerId = req.params?.providerId;
    const username = req.body?.username;

    if (providerId && typeof username === 'string' && username.length > 0) {
      return `ldap:${providerId}:${username.toLowerCase()}`;
    }

    // Без имени считать нечего: пусть работает счетчик по адресу.
    return super.getTracker(req as Parameters<ThrottlerGuard['getTracker']>[0]);
  }
}
