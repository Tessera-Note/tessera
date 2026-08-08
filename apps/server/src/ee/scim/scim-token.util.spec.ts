import {
  generateScimToken,
  hashScimToken,
  SCIM_TOKEN_PREFIX,
} from './scim-token.util';

/**
 * Токен предъявляется провайдером на каждом запросе, поэтому хеш быстрый.
 * Стойкость обеспечивается длиной секрета, а не медленностью хеша.
 */
describe('scim-token.util', () => {
  it('токен начинается с префикса, опознаваемого сканерами секретов', () => {
    expect(generateScimToken().token.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
  });

  it('два вызова дают разные токены', () => {
    expect(generateScimToken().token).not.toBe(generateScimToken().token);
  });

  it('хвост совпадает с последними четырьмя символами значения', () => {
    const { token, tokenLastFour } = generateScimToken();
    expect(tokenLastFour).toBe(token.slice(-4));
    expect(tokenLastFour).toHaveLength(4);
  });

  it('хеш соответствует значению и воспроизводим', () => {
    const { token, tokenHash } = generateScimToken();
    expect(hashScimToken(token)).toBe(tokenHash);
    expect(tokenHash).toHaveLength(64);
  });

  it('хеш не содержит самого значения', () => {
    const { token, tokenHash } = generateScimToken();
    expect(tokenHash).not.toContain(token.slice(SCIM_TOKEN_PREFIX.length));
  });

  it('секрет достаточно длинный, чтобы не перебираться', () => {
    const secret = generateScimToken().token.slice(SCIM_TOKEN_PREFIX.length);
    expect(secret.length).toBeGreaterThanOrEqual(40);
  });
});
