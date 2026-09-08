/**
 * Язык и словарь до первой отрисовки.
 *
 * Источников три, и порядок между ними важен: у вошедшего берётся его язык, у
 * листа печати — довод адреса (входа у браузера печати нет), у остальных —
 * язык браузера. Ошибка здесь не видна типами: страница просто выходит на
 * чужом языке.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/i18n', () => ({
  normalizeLocale: (value: string | null | undefined) => value ?? 'en-US',
  loadDictionary: (locale: string) => Promise.resolve({ locale })
}));

const { load } = await import('./+layout');

function run(data: unknown, search = '') {
  return (load as (event: unknown) => Promise<{ locale: string }>)({
    data,
    url: new URL(`http://localhost/pdf-render/p1${search}`),
    fetch
  });
}

describe('язык слоя', () => {
  it('у вошедшего берётся его язык', async () => {
    const result = await run({ session: { user: { locale: 'ru-RU' } } }, '?locale=uk-UA');
    expect(result.locale).toBe('ru-RU');
  });

  it('у листа печати — довод адреса', async () => {
    // Входа у браузера печати нет, и без довода лист уходит по-английски.
    const result = await run(null, '?locale=uk-UA');
    expect(result.locale).toBe('uk-UA');
  });

  it('без того и другого остаётся язык браузера', async () => {
    const result = await run(null);
    expect(result.locale).toBe('en-US');
  });
});
