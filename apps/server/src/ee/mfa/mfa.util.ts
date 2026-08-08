import { TOTP, Secret } from 'otpauth';
import { randomBytes, timingSafeEqual, createHash } from 'crypto';

/**
 * Параметры одноразовых кодов.
 *
 * Шесть цифр каждые тридцать секунд по SHA-1 это то, что умеют все
 * приложения-аутентификаторы. Отклоняться от значений по умолчанию нельзя:
 * приложение читает их из QR-кода, но часть приложений игнорирует нестандартные.
 */
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_ALGORITHM = 'SHA1';

/**
 * Допуск в один шаг в обе стороны.
 *
 * Часы на телефоне и на сервере расходятся, и без допуска пользователь
 * с расхождением в несколько секунд не войдет никогда. Больше одного шага
 * брать не стоит: каждый шаг это тридцать секунд, за которые код действителен.
 */
const TOTP_WINDOW = 1;

/** Длина и количество резервных кодов. */
const BACKUP_CODE_LENGTH = 8;
const BACKUP_CODE_COUNT = 10;

/**
 * Алфавит резервных кодов без символов, которые путаются при переписывании
 * с бумаги: ноль и буква O, единица и буквы I и L.
 */
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Новый секрет TOTP в виде base32, как его ждут приложения. */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function buildTotp(secret: string, label: string, issuer: string): TOTP {
  return new TOTP({
    issuer,
    label,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secret),
  });
}

/**
 * Ссылка otpauth для QR-кода.
 *
 * Издатель и метка попадают в название записи в приложении, поэтому в метку
 * идет почта пользователя: у человека может быть несколько учетных записей.
 */
export function buildTotpUri(
  secret: string,
  email: string,
  issuer: string,
): string {
  return buildTotp(secret, email, issuer).toString();
}

/**
 * Проверка одноразового кода.
 *
 * Возвращает false, а не бросает, на любом мусоре: код приходит от
 * пользователя, и нечитаемое значение это обычный неверный ввод.
 */
export function verifyTotp(secret: string, code: string): boolean {
  const cleaned = (code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;

  try {
    const delta = buildTotp(secret, 'x', 'x').validate({
      token: cleaned,
      window: TOTP_WINDOW,
    });
    return delta !== null;
  } catch {
    return false;
  }
}

/** Набор резервных кодов в открытом виде, показывается пользователю один раз. */
export function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i += 1) {
    const bytes = randomBytes(BACKUP_CODE_LENGTH);
    let code = '';
    for (let j = 0; j < BACKUP_CODE_LENGTH; j += 1) {
      code += BACKUP_ALPHABET[bytes[j] % BACKUP_ALPHABET.length];
    }
    codes.push(code);
  }
  return codes;
}

/**
 * Хеш резервного кода для хранения.
 *
 * В базе лежат только хеши: резервный код это второй фактор, и утечка
 * таблицы не должна давать возможность войти. Соли нет намеренно, код
 * случаен и достаточно длинен, а детерминированный хеш позволяет искать
 * совпадение без перебора всех кодов пользователя.
 */
export function hashBackupCode(code: string): string {
  return createHash('sha256').update(normalizeBackupCode(code)).digest('hex');
}

/** Приведение к виду хранения: без пробелов и дефисов, в верхнем регистре. */
export function normalizeBackupCode(code: string): string {
  return (code ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Поиск совпадения резервного кода среди хранимых хешей.
 *
 * Сравнение постоянного времени, чтобы по времени ответа нельзя было
 * подбирать код посимвольно. Возвращает индекс совпавшего хеша или -1.
 */
export function findBackupCodeIndex(
  storedHashes: string[],
  code: string,
): number {
  const candidate = hashBackupCode(code);
  const candidateBuffer = Buffer.from(candidate, 'hex');
  let match = -1;

  storedHashes.forEach((stored, index) => {
    let equal = false;
    try {
      const storedBuffer = Buffer.from(stored, 'hex');
      equal =
        storedBuffer.length === candidateBuffer.length &&
        timingSafeEqual(storedBuffer, candidateBuffer);
    } catch {
      equal = false;
    }
    // Цикл не прерывается: ранний выход выдал бы позицию совпадения
    // разницей во времени ответа.
    if (equal && match === -1) match = index;
  });

  return match;
}
