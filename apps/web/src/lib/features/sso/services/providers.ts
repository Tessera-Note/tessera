import { post } from '$lib/api/client';

/**
 * Провайдер входа в том виде, в каком его отдаёт сервер.
 *
 * Секретов здесь нет и быть не может: наружу идёт только признак того, что
 * секрет задан. Форма показывает пустое поле, и пустое же значение при
 * сохранении означает «не менять».
 */
export type AuthProvider = {
  id: string;
  name: string;
  type: 'oidc' | 'saml' | 'ldap' | 'google';
  isEnabled: boolean;
  allowSignup: boolean;
  groupSync: boolean;
  groupClaimName: string | null;
  /**
   * Какое утверждение провайдера считать неизменным ключом человека. Пусто —
   * сопоставление только по идентификатору и почте.
   */
  matchClaimName: string | null;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecretSet: boolean;
  samlUrl: string | null;
  samlCertificate: string | null;
  ldapUrl: string | null;
  ldapBaseDn: string | null;
  ldapBindDn: string | null;
  ldapBindPasswordSet: boolean;
  ldapUserSearchFilter: string | null;
  ldapUserAttributes: Record<string, string> | null;
  ldapTlsEnabled: boolean | null;
  ldapTlsCaCert: string | null;
  createdAt: string;
  /** Предупреждение о расхождении `APP_URL` с адресом интерфейса, если оно есть. */
  appUrlMismatch?: { appUrl: string; origin: string } | null;
};

export type ProviderValues = Partial<Omit<AuthProvider, 'id' | 'createdAt'>> & {
  name: string;
  type: AuthProvider['type'];
  oidcClientSecret?: string;
  ldapBindPassword?: string;
};

export function listProviders(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<{ items: AuthProvider[] }>('/api/sso/providers', {}, { fetcher, headers });
}

export function createProvider(values: ProviderValues, fetcher?: typeof fetch) {
  return post<AuthProvider>('/api/sso/create', values, { fetcher });
}

export function updateProvider(
  providerId: string,
  values: Partial<ProviderValues>,
  fetcher?: typeof fetch
) {
  return post<AuthProvider>('/api/sso/update', { providerId, ...values }, { fetcher });
}

export function deleteProvider(providerId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/sso/delete', { providerId }, { fetcher });
}

/** Снять связи участника с провайдерами. Нужно, когда провайдер сменил его идентификатор. */
export function unlinkUser(userId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean; unlinked: number }>('/api/sso/unlink', { userId }, { fetcher });
}

/**
 * «Это тот же человек»: связи записи-дубля с провайдерами переходят к прежней
 * записи, дубль отключается.
 *
 * Нужно, когда у провайдера сменились и идентификатор, и почта разом, а
 * неизменный ключ не настроен: вход тогда заводит вторую запись, и журнал
 * отмечает её как возможный дубль.
 */
export function mergeDuplicate(userId: string, targetUserId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean; moved: number }>(
    '/api/sso/merge',
    { userId, targetUserId },
    { fetcher }
  );
}
