import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ErrorMessage,
  badRequest,
  notFound,
  serviceUnavailable,
} from './app-error';

/**
 * Сообщения об отказах приходили с сервера готовым текстом на русском, и
 * клиент показывал именно их: человек с любой из двенадцати локалей видел
 * русскую строку, а заведенный рядом ключ перевода не отображался почти
 * никогда.
 *
 * Проверяется то, на чем держится схема: код уходит наружу, подстановки
 * уходят вместе с ним, а текст остается для журнала и для тех, кто читает API
 * напрямую.
 */
describe('Отказ с кодом', () => {
  it('код уходит наружу вместе с сообщением', () => {
    const error = badRequest('error.mfa.already_enabled');

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toEqual({
      code: 'error.mfa.already_enabled',
      message: 'Two-factor authentication is already enabled',
    });
  });

  it('код состояния берется от выбранного помощника', () => {
    expect(notFound('error.scim.token_not_found')).toBeInstanceOf(
      NotFoundException,
    );
    expect(
      serviceUnavailable('error.sso.directory_unavailable').getStatus(),
    ).toBe(503);
  });

  /** Клиент подставляет сам, но текст в журнале должен быть читаемым. */
  it('подстановки попадают и в текст, и наружу', () => {
    const error = badRequest('error.base.csv_row_limit', { limit: 5000 });

    expect(error.getResponse()).toEqual({
      code: 'error.base.csv_row_limit',
      message: 'CSV export is limited to 5000 rows',
      params: { limit: 5000 },
    });
  });

  it('несколько подстановок в одном тексте', () => {
    const error = badRequest('error.sso.provider_fields_required', {
      type: 'saml',
      fields: 'entryPoint, issuer',
    });

    expect((error.getResponse() as any).message).toBe(
      'Provider type saml requires: entryPoint, issuer',
    );
  });

  /** Пропущенное значение оставляет метку на месте, а не пустоту. */
  it('незаполненная подстановка остается видимой', () => {
    const error = badRequest('error.base.csv_row_limit', { other: 1 } as any);

    expect((error.getResponse() as any).message).toContain('{{limit}}');
  });

  it('без подстановок поле params наружу не уходит', () => {
    expect(
      badRequest('error.mfa.code_invalid').getResponse(),
    ).not.toHaveProperty('params');
  });

  /**
   * Код служит ключом перевода, поэтому пустой или неанглийский текст в
   * каталоге означал бы, что читающий API увидит пустоту, а Crowdin получит
   * строку на чужом языке.
   */
  it('каталог заполнен и написан по-английски', () => {
    const entries = Object.entries(ErrorMessage);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter(([, text]) => !text.trim())).toEqual([]);
    expect(entries.filter(([, text]) => /[А-Яа-яЁё]/.test(text))).toEqual([]);
  });

  it('все коды начинаются с error. и не повторяются', () => {
    const codes = Object.keys(ErrorMessage);

    expect(codes.filter((code) => !code.startsWith('error.'))).toEqual([]);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
