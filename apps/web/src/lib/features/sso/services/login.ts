/**
 * Вход по каталогу.
 *
 * Три протокола из четырёх уводят браузер на сайт провайдера и возвращаются
 * обратным вызовом; LDAP спрашивает имя и пароль на месте и отвечает сессией
 * сразу — каталог опрашивает сервер, ходить туда браузером неоткуда.
 */

import { post } from '$lib/api/client';

/** Сессию выдаёт сервер тем же cookie, что и парольный вход. */
export function ldapLogin(
  providerId: string,
  values: { username: string; password: string },
  fetcher?: typeof fetch
) {
  return post<{ status: string }>(`/api/sso/ldap/${providerId}/login`, values, { fetcher });
}
