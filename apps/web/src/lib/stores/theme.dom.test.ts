/**
 * Выбор темы.
 *
 * Проверяется различие выбора и показанного: выбор бывает трёх видов, показано
 * всегда одно из двух. Ошибка здесь означает, что «как в системе» превращается
 * в светлую тему после перезагрузки, и выбор живёт одну сессию.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { theme } from './theme.svelte';

/** Подставная системная настройка. В jsdom `matchMedia` нет вовсе. */
function systemIsDark(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  systemIsDark(false);
  document.documentElement.setAttribute('data-theme', 'light');
});

afterEach(() => {
  localStorage.clear();
});

describe('Тема', () => {
  it('запоминает выбор «как в системе»', () => {
    theme.set('auto');
    expect(localStorage.getItem('tessera.theme')).toBe('auto');
    // Иначе после перезагрузки выбор читается как светлая тема, и третий вид
    // живёт ровно до закрытия вкладки.
    expect(theme.choice).toBe('auto');
  });

  it('«как в системе» показывает тёмную, когда система тёмная', () => {
    systemIsDark(true);
    theme.set('auto');
    expect(theme.current).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('«как в системе» показывает светлую, когда система светлая', () => {
    systemIsDark(false);
    theme.set('auto');
    expect(theme.current).toBe('light');
  });

  it('явный выбор сильнее системы', () => {
    systemIsDark(true);
    theme.set('light');
    expect(theme.current).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('читает записанный выбор', () => {
    systemIsDark(true);
    localStorage.setItem('tessera.theme', 'auto');
    theme.hydrate();
    expect(theme.choice).toBe('auto');
    expect(theme.current).toBe('dark');
  });

  it('незнакомое записанное значение считается светлой темой', () => {
    localStorage.setItem('tessera.theme', 'сиреневая');
    theme.hydrate();
    expect(theme.choice).toBe('light');
    expect(theme.current).toBe('light');
  });

  it('переключатель в шапке знает два положения', () => {
    theme.set('auto');
    systemIsDark(true);
    theme.set('auto');
    expect(theme.current).toBe('dark');

    // Щелчок по переключателю уводит из «как в системе» в явный выбор: иначе
    // он ничего не менял бы, пока система тёмная.
    theme.toggle();
    expect(theme.choice).toBe('light');
    expect(theme.current).toBe('light');
  });
});
