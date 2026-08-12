/**
 * Вход разбирается на каждом запросе.
 *
 * На сервере кука сама не подставляется: её надо переложить из входящего
 * запроса в исходящий. Без этого страница, отрисованная сервером, всегда
 * выглядит как «не вошёл», и человек видит форму входа поверх своей вики.
 */

import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { setServerApiBase } from '$lib/api/base';
import { readSession } from '$lib/api/session';

// Адрес соседа для отрисовки на сервере. Ставится здесь, потому что этот файл
// не попадает в браузер, а приватное окружение туда попадать не должно.
// Значение по умолчанию совпадает с именем службы в развёртывании.
setServerApiBase(env.API_INTERNAL_URL || 'http://tessera-v2-api:3000');

export const handle: Handle = async ({ event, resolve }) => {
  const cookie = event.request.headers.get('cookie');
  event.locals.session = await readSession(event.fetch, cookie ? { cookie } : undefined);
  return resolve(event);
};
