/**
 * Язык и словарь до первой отрисовки.
 *
 * Источников три, и порядок между ними важен: у вошедшего берётся его язык, у
 * листа печати — довод адреса (входа у браузера печати нет), у остальных —
 * язык браузера. Ошибка здесь не видна типами: страница просто выходит на
 * чужом языке.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

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

// У Node 22 есть свой `navigator` с языком системы: без подмены проверка
// зависела бы от машины, на которой идёт.
afterEach(() => {
  vi.unstubAllGlobals();
});

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
    vi.stubGlobal('navigator', { language: 'de-DE' });
    const result = await run(null);
    expect(result.locale).toBe('de-DE');
  });

  it('на сервере, где браузера нет, — язык по умолчанию', async () => {
    vi.stubGlobal('navigator', undefined);
    const result = await run(null);
    expect(result.locale).toBe('en-US');
  });
});
