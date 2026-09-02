/**
 * Кто вошёл.
 *
 * Тот же состав полей, что отдаёт сервер: переименовывать их на клиенте
 * значило бы завести второй словарь имён, который расходится с первым при
 * первой же правке ответа.
 */

import { get } from './client';

export type User = {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  role: string | null;
  locale: string | null;
  /** Предпочтения показа и переключатели уведомлений, как их хранит сервер. */
  settings: {
    preferences?: { fullPageWidth?: boolean; pageEditMode?: string; editorToolbar?: boolean };
    notifications?: Record<string, boolean>;
  } | null;
};

export type Workspace = {
  id: string;
  name: string | null;
  hostname: string | null;
  logo: string | null;
  /** Разрешены ли личные пространства. Приходит со входом: настройки читает
   *  только администратор, а завести своё вправе каждый. */
  allowPersonalSpaces?: boolean;
  memberCount?: number;
};

export type Session = {
  user: User;
  workspace: Workspace;
};

/**
 * Прочитать вход.
 *
 * Отказ входа возвращается пустотой, а не исключением: «не вошёл» это обычное
 * состояние страницы, а не поломка, и обрабатывать его отдельным перехватом на
 * каждом маршруте не нужно.
 */
export async function readSession(fetcher: typeof fetch, headers?: Record<string, string>) {
  try {
    return await get<Session>('/api/auth/me', { fetcher, headers });
  } catch {
    return null;
  }
}
