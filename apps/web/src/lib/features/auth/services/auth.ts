/**
 * Вход, выход и всё, что вокруг него.
 *
 * Пути и имена полей взяты у сервера, а он взял их у v1: обе версии обязаны
 * понимать один и тот же запрос, пока идёт переход.
 */

import { get, post } from '$lib/api/client';
import type { Session } from '$lib/api/session';

export type LoginResult = Session & {
  expiresAt: string;
  /** Второй фактор заведён: сессии ещё нет, нужен код из приложения. */
  userHasMfa: boolean;
  /** Фактора нет, но рабочее пространство его требует: нужна настройка. */
  requiresMfaSetup: boolean;
};

export function login(email: string, password: string, fetcher?: typeof fetch) {
  return post<LoginResult>('/api/auth/login', { email, password }, { fetcher });
}

/**
 * Завершить вход вторым фактором.
 *
 * Промежуточный токен лежит в куке и живёт пять минут: он подтверждает только
 * то, что пароль сверен, и сам по себе приложение не открывает.
 */
export function completeMfaLogin(code: string, fetcher?: typeof fetch) {
  return post<LoginResult>('/api/mfa/challenge', { code }, { fetcher });
}

/**
 * Завести секрет тому, кого пространство обязало включить второй фактор.
 *
 * Отдельно от `mfaSetup` в настройках: там человек уже вошёл, здесь сессии
 * ещё нет и учётными данными служит промежуточный токен из куки.
 */
export function enrollMfaSetup(fetcher?: typeof fetch) {
  return post<{ secret: string; uri: string }>('/api/mfa/enroll-setup', {}, { fetcher });
}

/** Включить фактор кодом и войти. Резервные коды приходят один раз. */
export function enrollMfaEnable(code: string, fetcher?: typeof fetch) {
  return post<{ backupCodes: string[] }>('/api/mfa/enroll-enable', { code }, { fetcher });
}

export function logout(fetcher?: typeof fetch) {
  return post<void>('/api/auth/logout', {}, { fetcher });
}

export function setupRequired(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<{ requiresSetup: boolean }>('/api/auth/setup-required', { fetcher, headers });
}

export function setup(
  values: { workspaceName: string; name: string; email: string; password: string },
  fetcher?: typeof fetch
) {
  return post<LoginResult>('/api/auth/setup', values, { fetcher });
}

/**
 * Попросить ссылку для смены пароля.
 *
 * Ответ одинаков для заведённого и незаведённого адреса: разные ответы
 * позволяют перебором узнать, кто здесь работает.
 */
export function forgotPassword(email: string, fetcher?: typeof fetch) {
  return post<void>('/api/auth/forgot-password', { email }, { fetcher });
}

export function resetPassword(token: string, newPassword: string, fetcher?: typeof fetch) {
  return post<LoginResult>('/api/auth/password-reset', { token, newPassword }, { fetcher });
}

export function verifyToken(token: string, fetcher?: typeof fetch) {
  return post<{ valid: boolean }>('/api/auth/verify-token', { token }, { fetcher });
}

export function changePassword(oldPassword: string, newPassword: string, fetcher?: typeof fetch) {
  return post<void>('/api/auth/change-password', { oldPassword, newPassword }, { fetcher });
}

export type PublicWorkspace = {
  id: string;
  name: string | null;
  logo: string | null;
  hostname: string | null;
  enforceSso: boolean;
  authProviders: { id: string; name: string; type: string }[];
};

/** Сведения для экрана входа: имя пространства и список провайдеров. */
export function publicWorkspace(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<PublicWorkspace>('/api/workspace/public', {}, { fetcher, headers });
}

export function acceptInvite(
  values: { invitationId: string; token: string; name: string; password: string },
  fetcher?: typeof fetch
) {
  return post<LoginResult>('/api/workspace/invites/accept', values, { fetcher });
}
