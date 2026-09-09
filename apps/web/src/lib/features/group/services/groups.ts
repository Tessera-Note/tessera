import { get, post } from '$lib/api/client';

export type Group = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  directorySource: string | null;
  memberCount: number;
};

export type GroupMember = {
  id: string;
  name: string | null;
  email: string;
};

/** Страница перечня и курсор следующей. Пустой курсор означает конец. */
export type Paged<T> = { items: T[]; meta: { nextCursor: string | null } };

/**
 * Группы рабочего пространства со счётчиком людей.
 *
 * Постранично: на рабочем пространстве с сотнями групп перечень целиком
 * приходил бы в каждом ответе экрана.
 */
export function listGroups(
  values: { cursor?: string; limit?: number; q?: string } = {},
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  const query = new URLSearchParams();
  if (values.cursor) query.set('cursor', values.cursor);
  if (values.limit) query.set('limit', String(values.limit));
  // Отбор по имени идёт на сервере: перечень постраничный, и отбор здесь искал
  // бы только в показанной странице.
  if (values.q) query.set('q', values.q);
  const tail = query.toString();
  return get<Paged<Group>>(`/api/groups${tail ? `?${tail}` : ''}`, { fetcher, headers });
}

export function groupInfo(
  groupId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Group>('/api/groups/info', { groupId }, { fetcher, headers });
}

/**
 * Состав группы.
 *
 * Виден администратору: сервер отдаёт адреса почты и по этой причине закрывает
 * список от обычного участника. Выбрать группу для выдачи доступа можно и по
 * имени, состав для этого не нужен.
 *
 * Постранично: в группе бывает тысяча человек, и весь состав в одном ответе
 * рос бы вместе с рабочим пространством.
 */
export function groupMembers(
  values: { groupId: string; cursor?: string; limit?: number },
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Paged<GroupMember>>('/api/groups/members', values, { fetcher, headers });
}

export function createGroup(
  name: string,
  description?: string,
  userIds?: string[],
  fetcher?: typeof fetch
) {
  return post<Group>('/api/groups/create', { name, description, userIds }, { fetcher });
}

/**
 * Передать группу под управление каталога.
 *
 * После этого состав ведёт провайдер, а руками группа не правится: следующий
 * цикл синхронизации всё равно вернёт своё. Пустой ключ означает «как
 * называется здесь».
 */
export function attachDirectory(
  groupId: string,
  providerId: string,
  directoryKey?: string,
  fetcher?: typeof fetch
) {
  return post<Group>(
    '/api/groups/attach-directory',
    { groupId, providerId, directoryKey },
    { fetcher }
  );
}

/** Вернуть группу под ручное управление. Состав при этом сохраняется. */
export function detachDirectory(groupId: string, fetcher?: typeof fetch) {
  return post<Group>('/api/groups/detach-directory', { groupId }, { fetcher });
}

export function updateGroup(
  groupId: string,
  values: { name?: string; description?: string },
  fetcher?: typeof fetch
) {
  return post<Group>('/api/groups/update', { groupId, ...values }, { fetcher });
}

export function deleteGroup(groupId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/groups/delete', { groupId }, { fetcher });
}

export function addGroupMembers(groupId: string, userIds: string[], fetcher?: typeof fetch) {
  return post<{ added: number }>('/api/groups/members/add', { groupId, userIds }, { fetcher });
}

export function removeGroupMember(groupId: string, userId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/groups/members/remove', { groupId, userId }, { fetcher });
}
