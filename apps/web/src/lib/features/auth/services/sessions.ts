import { post } from '$lib/api/client';

export type Session = {
  id: string;
  deviceName: string | null;
  userAgent: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  expiresAt: string | null;
  /** Тот сеанс, из которого сделан запрос. Его не закрывают: для выхода есть выход. */
  isCurrent: boolean;
};

export function listSessions(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<Session[]>('/api/auth/sessions', {}, { fetcher, headers });
}

export function revokeSession(sessionId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/auth/sessions/revoke', { sessionId }, { fetcher });
}

export function revokeOtherSessions(fetcher?: typeof fetch) {
  return post<{ revoked: number }>('/api/auth/sessions/revoke-all', {}, { fetcher });
}
