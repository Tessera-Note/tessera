import { get } from '$lib/api/client';

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
