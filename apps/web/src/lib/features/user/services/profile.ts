import { post } from '$lib/api/client';
import type { User } from '$lib/api/session';

/**
 * Правка своей учётной записи.
 *
 * Поле, которого нет в запросе, сервер не трогает: экран шлёт то, что человек
 * менял, и передача пустых значений стирала бы имя при смене языка.
 */
export function updateProfile(values: { name?: string; locale?: string }, fetcher?: typeof fetch) {
  return post<User>('/api/users/update', values, { fetcher });
}
