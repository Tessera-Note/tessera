import { get, post } from '$lib/api/client';

export type Space = {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  role: string | null;
  /** Имя файла значка, а не адрес: адрес собирает `imageUrl`. */
  logo?: string | null;
};

export function listSpaces(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<Space[]>('/api/spaces', { fetcher, headers });
}

export function getSpace(slug: string, fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<Space>(`/api/spaces/${encodeURIComponent(slug)}`, { fetcher, headers });
}

/**
 * Личное пространство человека, если оно заведено.
 *
 * Отдельным вызовом, а не признаком в общем списке: сервер отдаёт его по
 * запросу самого человека, и признак в общем списке пришлось бы считать для
 * каждой строки.
 */
export function personalSpace(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<Space | null>('/api/personal-space/info', {}, { fetcher, headers });
}

/** Завести своё личное пространство. Оно у человека одно. */
export function createPersonalSpace(name?: string, fetcher?: typeof fetch) {
  return post<Space>('/api/personal-space/create', { name }, { fetcher });
}

/** Участник пространства: имя и почта, без роли — она нужна другому экрану. */
export type SpaceMember = { id: string; name: string | null; email: string };

/**
 * Участники пространства.
 *
 * Отсюда, а не из списка участников рабочего пространства: тот виден только
 * администратору, и обычному участнику некого было бы выбрать при выдаче
 * доступа к странице.
 */
export function spaceMembers(
  spaceId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<SpaceMember[]>('/api/spaces/members', { spaceId }, { fetcher, headers });
}

/** Роли в пространстве. Значения и подписи из v1: их же понимает сервер. */
export const SPACE_ROLES = [
  { value: 'admin', label: 'Full access' },
  { value: 'writer', label: 'Can edit' },
  { value: 'reader', label: 'Can view' }
] as const;

/** Участник пространства: человек либо группа, ровно одно из двух. */
export type SpaceMemberRow = {
  id: string;
  role: string;
  userId: string | null;
  groupId: string | null;
  name: string | null;
  email: string | null;
  type: 'user' | 'group';
};

export function createSpace(
  values: { name: string; description?: string; slug?: string },
  fetcher?: typeof fetch
) {
  return post<Space>('/api/spaces/create', values, { fetcher });
}

/** Поле, которого нет в запросе, сервер не трогает. */
export function updateSpace(
  values: { spaceId: string; name?: string; description?: string; slug?: string },
  fetcher?: typeof fetch
) {
  return post<Space>('/api/spaces/update', values, { fetcher });
}

export function deleteSpace(spaceId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/spaces/delete', { spaceId }, { fetcher });
}

/**
 * Состав пространства с ролями.
 *
 * Отдельно от `spaceMembers`: тот отдаёт людей для выбора и намеренно не несёт
 * ни ролей, ни групп.
 */
export function spaceMemberList(
  spaceId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<SpaceMemberRow[]>('/api/spaces/members/list', { spaceId }, { fetcher, headers });
}

export function addSpaceMembers(
  values: { spaceId: string; role: string; userIds?: string[]; groupIds?: string[] },
  fetcher?: typeof fetch
) {
  return post<{ added: number }>('/api/spaces/members/add', values, { fetcher });
}

export function removeSpaceMember(
  values: { spaceId: string; userId?: string; groupId?: string },
  fetcher?: typeof fetch
) {
  return post<{ success: boolean }>('/api/spaces/members/remove', values, { fetcher });
}

export function changeSpaceMemberRole(
  values: { spaceId: string; role: string; userId?: string; groupId?: string },
  fetcher?: typeof fetch
) {
  return post<{ success: boolean }>('/api/spaces/members/change-role', values, { fetcher });
}

export type SpaceWatchStatus = { isWatching: boolean };

/**
 * Подписка на пространство.
 *
 * Подписан на пространство — значит получаешь всё, что в нём происходит.
 * Право то же, что на чтение: подписка не даёт видеть больше, чем видно.
 * Отписаться при этом можно и потеряв доступ, иначе отобранный доступ навсегда
 * оставлял бы человека в получателях извещений.
 */
export function watchSpace(spaceId: string, fetcher?: typeof fetch) {
  return post<SpaceWatchStatus>('/api/spaces/watch', { spaceId }, { fetcher });
}

export function unwatchSpace(spaceId: string, fetcher?: typeof fetch) {
  return post<SpaceWatchStatus>('/api/spaces/unwatch', { spaceId }, { fetcher });
}

export function spaceWatchStatus(
  spaceId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<SpaceWatchStatus>('/api/spaces/watch-status', { spaceId }, { fetcher, headers });
}

/** Подсказка выбора: человек либо группа. */
export type Suggestion = { users: SpaceMember[]; groups: { id: string; name: string }[] };

/**
 * Подсказки людей и групп по началу имени или адреса.
 *
 * Пустой запрос сервер не обслуживает намеренно: иначе один вызов отдавал бы
 * перечень всех работающих.
 */
export function suggest(
  query: string,
  options: { includeUsers?: boolean; includeGroups?: boolean } = {},
  fetcher?: typeof fetch
) {
  return post<Suggestion>(
    '/api/search/suggest',
    {
      query,
      includeUsers: options.includeUsers ?? true,
      includeGroups: options.includeGroups ?? false
    },
    { fetcher }
  );
}
