import { createHash, randomBytes } from 'crypto';

/**
 * Префикс токена SCIM.
 *
 * Нужен не для красоты: по нему утекший токен опознается в логах и в чужих
 * репозиториях автоматическими сканерами секретов. Без префикса случайная
 * строка неотличима от любой другой.
 */
export const SCIM_TOKEN_PREFIX = 'tsr_scim_';

/** Длина случайной части в байтах. */
const SECRET_BYTES = 32;

export type GeneratedScimToken = {
  /** Значение, которое показывается администратору один раз. */
  token: string;
  /** То, что уходит в базу вместо значения. */
  tokenHash: string;
  /** Хвост для опознания токена в списке. */
  tokenLastFour: string;
};

/**
 * Хеш токена.
 *
 * SHA-256, а не bcrypt: токен предъявляется на каждом запросе провайдера,
 * и медленный хеш превратил бы синхронизацию в нагрузку на процессор.
 * Стойкость здесь обеспечивается не медленностью, а длиной секрета:
 * 32 случайных байта не перебираются, в отличие от пароля человека.
 * Тот же прием применен к резервным кодам второго фактора.
 */
export function hashScimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateScimToken(): GeneratedScimToken {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${SCIM_TOKEN_PREFIX}${secret}`;

  return {
    token,
    tokenHash: hashScimToken(token),
    tokenLastFour: token.slice(-4),
  };
}
