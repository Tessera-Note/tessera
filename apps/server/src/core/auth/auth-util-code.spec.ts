import { throwIfEmailNotVerified } from './auth.util';

/**
 * Клиент по этому отказу уводит на страницу подтверждения почты, и раньше он
 * узнавал его сравнением английского текста сообщения. Перевод сообщения
 * сломал бы переход молча, поэтому наружу идет код.
 */
const OPTS = {
  isCloud: true,
  emailVerifiedAt: null as Date | null,
  email: 'u@example.com',
  workspaceId: 'ws-1',
  appSecret: 'секрет',
};

describe('throwIfEmailNotVerified', () => {
  it('отказ несет код и подпись адреса', () => {
    try {
      throwIfEmailNotVerified(OPTS);
      throw new Error('отказа не было');
    } catch (err: any) {
      const body = err.getResponse();
      expect(body.code).toBe('error.auth.email_not_verified');
      expect(body.emailSignature).toEqual(expect.any(String));
    }
  });

  it('подтвержденная почта отказа не дает', () => {
    expect(() =>
      throwIfEmailNotVerified({ ...OPTS, emailVerifiedAt: new Date() }),
    ).not.toThrow();
  });

  it('вне облака проверка не применяется', () => {
    expect(() =>
      throwIfEmailNotVerified({ ...OPTS, isCloud: false }),
    ).not.toThrow();
  });
});
