import { post } from '$lib/api/client';

export type Version = {
  id: string;
  version: number;
  title: string | null;
  lastUpdatedById: string | null;
  createdAt: string;
};

export type VersionBody = Version & { content: unknown };

export function listVersions(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<Version[]>('/api/pages/history/list', { pageId }, { fetcher, headers });
}

export function getVersion(
  versionId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<VersionBody>('/api/pages/history/get', { versionId }, { fetcher, headers });
}
