import { get, post } from '$lib/api/client';

export type Member = {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  avatarUrl: string | null;
  deactivatedAt: string | null;
};

export type Invitation = {
  id: string;
  email: string | null;
  role: string;
  createdAt: string;
};

/** Роли рабочего пространства. Значения из v1: их же понимает сервер. */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;

export function listMembers(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<Member[]>('/api/workspace/members', { fetcher, headers });
}

export function listInvitations(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<Invitation[]>('/api/workspace/invites', { fetcher, headers });
}

export function changeRole(userId: string, role: string, fetcher?: typeof fetch) {
  return post<Member>('/api/workspace/members/change-role', { userId, role }, { fetcher });
}

/**
 * Отключить или включить участника.
 *
 * Отключение, а не удаление: удалённый участник унёс бы с собой авторство
 * страниц и комментариев, а отключённый просто перестаёт входить.
 */
export function setActive(userId: string, active: boolean, fetcher?: typeof fetch) {
  const path = active ? 'activate' : 'deactivate';
  return post<Member>(`/api/workspace/members/${path}`, { userId }, { fetcher });
}

/**
 * Удалить участника.
 *
 * Отличие от отключения существенное. Отключение закрывает вход и обратимо;
 * удаление обезличивает запись и снимает всё, что даёт доступ, — членство в
 * пространствах, группы, связи с провайдерами входа. Сама запись остаётся: на
 * неё ссылаются страницы, правки и журнал.
 */
export function deleteMember(userId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/workspace/members/delete', { userId }, { fetcher });
}

export function invite(emails: string[], role: string, fetcher?: typeof fetch) {
  return post<Invitation[]>('/api/workspace/invites', { emails, role }, { fetcher });
}

export function revokeInvitation(invitationId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/workspace/invites/revoke', { invitationId }, { fetcher });
}

/** Отправить письмо приглашения ещё раз. Токен при этом не меняется. */
export function resendInvitation(invitationId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/workspace/invites/resend', { invitationId }, { fetcher });
}

/**
 * Ссылка приглашения.
 *
 * Нужна там, где почта не настроена или письмо не дошло: администратор
 * передаёт ссылку сам. Ссылка равносильна приглашению — по ней заводится
 * участник, — поэтому получить её может только тот, кто вправе приглашать.
 */
export function invitationLink(invitationId: string, fetcher?: typeof fetch) {
  return post<{ inviteLink: string }>('/api/workspace/invites/link', { invitationId }, { fetcher });
}
