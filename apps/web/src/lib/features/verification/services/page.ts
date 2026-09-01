import { post } from '$lib/api/client';

/** Настройка проверки страницы так, как её показывают человеку. */
export type VerificationInfo = {
  configured: boolean;
  id?: string;
  status?: string;
  mode?: string;
  periodAmount?: number | null;
  periodUnit?: string | null;
  verifiedAt?: string | null;
  verifiedById?: string | null;
  expiresAt?: string | null;
  requestedAt?: string | null;
  rejectedAt?: string | null;
  rejectionComment?: string | null;
  verifiers?: { userId: string; isPrimary: boolean }[];
  canVerify: boolean;
  canManage: boolean;
  canSubmit: boolean;
};

/** Единицы срока. Значения понимает сервер, подписи видит человек. */
export const PERIOD_UNITS = [
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
  { value: 'year', label: 'Years' }
] as const;

export function verificationInfo(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<VerificationInfo>('/api/pages/verification-info', { pageId }, { fetcher, headers });
}

/**
 * Завести проверку.
 *
 * Проверяющих задают сразу: без них подтверждать некому, а право правки
 * страницы подтверждения не даёт — иначе настройка позволяла бы подтвердить
 * самому себе.
 */
export function configureVerification(
  values: {
    pageId: string;
    mode?: string;
    periodAmount?: number;
    periodUnit?: string;
    verifierIds?: string[];
  },
  fetcher?: typeof fetch
) {
  return post<VerificationInfo>('/api/pages/create-verification', values, { fetcher });
}

export function removeVerification(pageId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/pages/delete-verification', { pageId }, { fetcher });
}

export function verifyPage(pageId: string, fetcher?: typeof fetch) {
  return post<VerificationInfo>('/api/pages/verify', { pageId }, { fetcher });
}

export function submitForApproval(pageId: string, fetcher?: typeof fetch) {
  return post<VerificationInfo>('/api/pages/submit-for-approval', { pageId }, { fetcher });
}

export function rejectApproval(
  pageId: string,
  comment: string | undefined,
  fetcher?: typeof fetch
) {
  return post<VerificationInfo>('/api/pages/reject-approval', { pageId, comment }, { fetcher });
}

export function markObsolete(pageId: string, fetcher?: typeof fetch) {
  return post<VerificationInfo>('/api/pages/mark-obsolete', { pageId }, { fetcher });
}
