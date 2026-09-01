import { post } from '$lib/api/client';

/** Строка перечня проверяемых страниц. */
export type VerificationRow = {
  id: string;
  pageId: string;
  status: string;
  mode: string;
  expiresAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  pageTitle: string | null;
  pageSlugId: string;
  pageIcon: string | null;
  spaceName: string | null;
  spaceSlug: string;
};

/** Состояния записи. Значения понимает сервер, подписи видит человек. */
export const VERIFICATION_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'pending_approval', label: 'In approval' },
  { value: 'verified', label: 'Verified' },
  { value: 'rejected', label: 'Approval rejected' },
  { value: 'expiring', label: 'Expiring' },
  { value: 'expired', label: 'Expired' },
  { value: 'obsolete', label: 'Obsolete' }
] as const;

/**
 * Проверяемые страницы доступных пространств.
 *
 * Выдача ограничена потолком и отдаётся целиком: экран открывают, чтобы окинуть
 * взглядом, а не листать.
 */
export function listVerifications(
  values: { spaceId?: string; status?: string } = {},
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<VerificationRow[]>('/api/pages/verifications', values, { fetcher, headers });
}
