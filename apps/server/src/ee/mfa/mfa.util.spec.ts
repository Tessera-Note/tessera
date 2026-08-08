import {
  buildTotpUri,
  findBackupCodeIndex,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  normalizeBackupCode,
  verifyTotp,
} from './mfa.util';
import { TOTP, Secret } from 'otpauth';

const currentCode = (secret: string) =>
  new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();

describe('mfa.util, секрет и ссылка', () => {
  it('секрет в base32 и достаточной длины', () => {
    const secret = generateTotpSecret();

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it('каждый вызов дает новый секрет', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  // Приложение читает параметры из ссылки, отклоняться от стандартных нельзя.
  it('ссылка содержит издателя, метку и стандартные параметры', () => {
    const uri = buildTotpUri('JBSWY3DPEHPK3PXP', 'user@example.com', 'Tessera');

    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('issuer=Tessera');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('algorithm=SHA1');
  });
});

describe('mfa.util, проверка одноразового кода', () => {
  const secret = generateTotpSecret();

  it('текущий код принимается', () => {
    expect(verifyTotp(secret, currentCode(secret))).toBe(true);
  });

  it('код с пробелами принимается', () => {
    const code = currentCode(secret);

    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(
      true,
    );
  });

  it('чужой код отвергается', () => {
    const other = generateTotpSecret();

    expect(verifyTotp(secret, currentCode(other))).toBe(false);
  });

  // Нечитаемое значение это обычный неверный ввод, а не повод падать.
  it.each([['', 'пусто'], ['abcdef', 'буквы'], ['12345', 'пять цифр'], ['1234567', 'семь цифр']])(
    'значение %s (%s) отвергается без исключения',
    (code) => {
      expect(verifyTotp(secret, code)).toBe(false);
    },
  );

  it('мусорный секрет не роняет проверку', () => {
    expect(verifyTotp('не base32!!', '123456')).toBe(false);
  });
});

describe('mfa.util, резервные коды', () => {
  it('выдается десять кодов по восемь символов', () => {
    const codes = generateBackupCodes();

    expect(codes).toHaveLength(10);
    expect(codes.every((c) => c.length === 8)).toBe(true);
  });

  // Ноль и O, единица и I с L путаются при переписывании с бумаги.
  it('в кодах нет путающихся символов', () => {
    const codes = generateBackupCodes().join('');

    expect(codes).not.toMatch(/[01OIL]/);
  });

  it('коды не повторяются', () => {
    const codes = generateBackupCodes();

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('хеш детерминирован и не содержит исходный код', () => {
    const hash = hashBackupCode('ABCD2345');

    expect(hash).toBe(hashBackupCode('ABCD2345'));
    expect(hash).not.toContain('ABCD2345');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['abcd2345', 'нижний регистр'],
    ['ABCD-2345', 'с дефисом'],
    [' ABCD 2345 ', 'с пробелами'],
  ])('%s (%s) приводится к тому же виду', (input) => {
    expect(normalizeBackupCode(input)).toBe('ABCD2345');
    expect(hashBackupCode(input)).toBe(hashBackupCode('ABCD2345'));
  });
});

describe('mfa.util, поиск резервного кода', () => {
  const codes = ['ABCD2345', 'EFGH6789', 'JKMN2345'];
  const hashes = codes.map(hashBackupCode);

  it('находит позицию совпавшего кода', () => {
    expect(findBackupCodeIndex(hashes, 'EFGH6789')).toBe(1);
  });

  it('несовпавший код дает минус один', () => {
    expect(findBackupCodeIndex(hashes, 'ZZZZ9999')).toBe(-1);
  });

  it('пустой набор дает минус один', () => {
    expect(findBackupCodeIndex([], 'ABCD2345')).toBe(-1);
  });

  it('испорченный хеш в наборе не роняет поиск', () => {
    expect(findBackupCodeIndex(['не хеш', ...hashes], 'ABCD2345')).toBe(1);
  });
});
