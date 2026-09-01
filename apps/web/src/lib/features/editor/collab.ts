import { post } from '$lib/api/client';

/**
 * Токен для сеанса совместного редактирования.
 *
 * Отдельный вид токена, короткоживущий: сервис редактирования держит соединение
 * сам и в базу за проверкой не ходит, поэтому токен доступа туда отдавать
 * нельзя — он дал бы этому процессу право ходить в приложение от имени
 * человека.
 */
export function collabToken(fetcher?: typeof fetch) {
  return post<{ token: string }>('/api/auth/collab-token', {}, { fetcher });
}

/**
 * Адрес канала редактирования.
 *
 * Тот же путь, что в v1: `/collab` на том же происхождении, что и страница.
 * Схема выводится из адреса страницы, иначе за обратным прокси с TLS браузер
 * откажется открывать незащищённое соединение.
 */
export function collabAddress(): string {
  const secure = window.location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${window.location.host}/collab`;
}

/** Имя документа. Совпадает с тем, что разбирает сервис: `page.<id>`. */
export function documentName(pageId: string): string {
  return `page.${pageId}`;
}
