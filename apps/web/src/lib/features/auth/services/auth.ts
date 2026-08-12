/**
 * Вход и выход.
 *
 * Пути и имена полей взяты у сервера, а он взял их у v1: обе версии обязаны
 * понимать один и тот же запрос, пока идёт переход.
 */

import { post } from '$lib/api/client';
import type { Session } from '$lib/api/session';

export type LoginResult = Session & { expiresAt: string };

export function login(email: string, password: string, fetcher?: typeof fetch) {
  return post<LoginResult>('/api/auth/login', { email, password }, { fetcher });
}

export function logout(fetcher?: typeof fetch) {
  return post<void>('/api/auth/logout', {}, { fetcher });
}

export function setupRequired(fetcher?: typeof fetch) {
  return post<{ requiresSetup: boolean }>('/api/auth/setup-required', {}, { fetcher });
}
