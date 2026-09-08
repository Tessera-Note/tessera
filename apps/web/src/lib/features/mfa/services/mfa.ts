import { post } from '$lib/api/client';

export type MfaStatus = {
  enabled: boolean;
  method: string | null;
  backupCodesLeft: number;
  /** Кодов осталось мало: пора выпустить новые, пока вход ещё возможен. */
  backupCodesLow: boolean;
  /** Рабочее пространство требует второй фактор от всех. */
  enforced: boolean;
};

/** Ответ на заведение секрета. Секрет показывается один раз, до включения. */
export type MfaSetup = { secret: string; uri: string };

export function mfaStatus(fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<MfaStatus>('/api/mfa/status', {}, { fetcher, headers });
}

/**
 * Завести секрет.
 *
 * Второй фактор при этом не включается: сперва человек вносит секрет в
 * приложение и подтверждает кодом. Включение до подтверждения заперло бы того,
 * кто секрет не сохранил.
 */
export function mfaSetup(fetcher?: typeof fetch) {
  return post<MfaSetup>('/api/mfa/setup', {}, { fetcher });
}

export function mfaEnable(code: string, fetcher?: typeof fetch) {
  return post<{ backupCodes: string[] }>('/api/mfa/enable', { code }, { fetcher });
}

/**
 * Снять второй фактор у другого человека.
 *
 * Право администратора, и сервер это проверяет. Нужен, когда человек потерял
 * устройство: сам он войти уже не может, а при обязательном втором факторе не
 * может и никто другой ему помочь. Человеку уходит письмо, действие пишется в
 * журнал — снятие защиты не должно проходить незаметно.
 */
export function resetMfaFor(userId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/mfa/reset', { userId }, { fetcher });
}

export function mfaDisable(code: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/mfa/disable', { code }, { fetcher });
}

export function mfaNewBackupCodes(code: string, fetcher?: typeof fetch) {
  return post<{ backupCodes: string[] }>('/api/mfa/generate-backup-codes', { code }, { fetcher });
}
