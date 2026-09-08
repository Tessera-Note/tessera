import { post } from '$lib/api/client';

export type AuditRecord = {
  id: string;
  event: string;
  resourceType: string | null;
  resourceId: string | null;
  spaceId: string | null;
  actorType: string | null;
  changes: unknown;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string | null;
  actor: { id: string; name: string | null; email: string; avatarUrl: string | null } | null;
};

export type AuditPage = { items: AuditRecord[]; meta: { nextCursor: string | null } };

export type AuditFilter = {
  event?: string;
  resourceType?: string;
  actorId?: string;
  spaceId?: string;
  startDate?: string;
  endDate?: string;
  cursor?: string;
  limit?: number;
};

/**
 * Страница журнала, от свежих к старым.
 *
 * Постраничность курсорная: журнал пополняется во время просмотра, и смещение
 * сдвигало бы окно — часть записей показывалась бы дважды, часть терялась.
 */
export function listAudit(
  filter: AuditFilter = {},
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<AuditPage>('/api/audit', filter, { fetcher, headers });
}

export function auditRetention(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<{ retentionDays: number }>('/api/audit/retention', {}, { fetcher, headers });
}

export function setAuditRetention(auditRetentionDays: number, fetcher?: typeof fetch) {
  return post<{ retentionDays: number }>(
    '/api/audit/retention/update',
    { auditRetentionDays },
    { fetcher }
  );
}
