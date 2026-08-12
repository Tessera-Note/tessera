import { get, post } from '$lib/api/client';

export type WorkspaceSettings = {
  id: string;
  name: string | null;
  description: string | null;
  hostname: string | null;
  trashRetentionDays: number | null;
  enforceMfa: boolean;
  enforceSso: boolean;
  disablePublicSharing: boolean;
  restrictApiToAdmins: boolean;
  allowMemberTemplates: boolean;
};

/** Правится по одному полю: экран шлёт изменённое, остальное сервер не трогает. */
export type WorkspacePatch = Partial<
  Omit<WorkspaceSettings, 'id' | 'hostname'> & { trashRetentionDays: number }
>;

export function workspaceSettings(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return get<WorkspaceSettings>('/api/workspace/settings', { fetcher, headers });
}

export function updateWorkspace(values: WorkspacePatch, fetcher?: typeof fetch) {
  return post<WorkspaceSettings>('/api/workspace/update', values, { fetcher });
}
