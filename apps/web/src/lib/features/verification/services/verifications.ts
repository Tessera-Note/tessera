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

/** Страница перечня и место, откуда продолжать. */
export type VerificationPage = {
  items: VerificationRow[];
  meta: { nextCursor: string | null };
};

/**
 * Проверяемые страницы доступных пространств.
 *
 * Выдача постраничная: отбор по правам выбрасывает строки уже после выборки,
 * поэтому страница бывает короче запрошенной — конец перечня показывает пустой
 * `nextCursor`, а не короткая страница.
 */
export function listVerifications(
  values: {
    spaceId?: string;
    status?: string;
    query?: string;
    verifierId?: string;
    cursor?: string;
    limit?: number;
  } = {},
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<VerificationPage>('/api/pages/verifications', values, { fetcher, headers });
}
