import { get, post } from '$lib/api/client';

export type Space = {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  role: string | null;
};

export function listSpaces(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<Space[]>('/api/spaces', { fetcher, headers });
}

export function getSpace(slug: string, fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<Space>(`/api/spaces/${encodeURIComponent(slug)}`, { fetcher, headers });
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
