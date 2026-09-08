/**
 * Цвет метки.
 *
 * Проверяется устойчивость и разброс. Цвет выводится из имени, и одно и то же
 * слово обязано давать один и тот же цвет на всех экранах: иначе метка на
 * странице и та же метка в перечне выглядят разными.
 */

import { describe, expect, it } from 'vitest';
import { labelColor } from './colors';

describe('labelColor', () => {
  it('одно имя — один цвет', () => {
    expect(labelColor('регламент')).toEqual(labelColor('регламент'));
  });

  it('у светлой и тёмной темы свои цвета', () => {
    expect(labelColor('регламент', 'light')).not.toEqual(labelColor('регламент', 'dark'));
  });

  it('разные имена расходятся по палитре', () => {
    // Свёртка на 31 без перемешивания сбивала короткие слова в два цвета из
    // восьми: 31 ≡ −1 (mod 8), и деление берёт как раз младшие биты.
    const names = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'tau', 'zeta'];
    const used = new Set(names.map((one) => labelColor(one).bg));
    expect(used.size).toBeGreaterThanOrEqual(4);
  });

  it('пустое имя не роняет разбор', () => {
    expect(labelColor('')).toHaveProperty('bg');
  });

  it('цвет всегда из палитры', () => {
    for (const name of ['один', 'два', 'три', 'четыре']) {
      const color = labelColor(name);
      expect(color.bg).toMatch(/^#[0-9a-f]{6}$/);
      expect(color.fg).toMatch(/^#[0-9a-f]{6}$/);
      expect(color.dot).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
