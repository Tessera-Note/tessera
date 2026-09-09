/**
 * Настройки чтения.
 *
 * Проверяются умолчания: они у двух переключателей разные, и перепутанное
 * умолчание даёт переключатель, который не делает того, что обещает.
 */

import { describe, expect, it } from 'vitest';
import { wantsToolbar, wantsWidePage } from './profile';

describe('wantsWidePage', () => {
  it('без настройки лист узкий', () => {
    // Настройка заводится включением: её отсутствие означает, что человек её
    // не включал.
    expect(wantsWidePage(undefined)).toBe(false);
    expect(wantsWidePage(null)).toBe(false);
    expect(wantsWidePage({})).toBe(false);
  });

  it('включённая настройка расширяет лист', () => {
    expect(wantsWidePage({ fullPageWidth: true })).toBe(true);
  });

  it('выключенная настройка оставляет узкий', () => {
    expect(wantsWidePage({ fullPageWidth: false })).toBe(false);
  });
});

describe('wantsToolbar', () => {
  it('без настройки полоса показывается', () => {
    // Умолчание обратное ширине: полоса была до появления настройки, и её
    // отсутствие означает согласие.
    expect(wantsToolbar(undefined)).toBe(true);
    expect(wantsToolbar(null)).toBe(true);
    expect(wantsToolbar({})).toBe(true);
  });

  it('отказ убирает полосу', () => {
    expect(wantsToolbar({ editorToolbar: false })).toBe(false);
  });

  it('согласие оставляет полосу', () => {
    expect(wantsToolbar({ editorToolbar: true })).toBe(true);
  });
});
