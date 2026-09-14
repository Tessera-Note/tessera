/**
 * Полотно листа на печати.
 *
 * Проверяется правило в общей таблице стилей, а не разметка: лист печатается с
 * фонами (`printBackground` у Gotenberg, «фоновая графика» в самом браузере), а
 * фон полотна Chromium берёт с `html` — там стоит цвет поверхности приложения.
 * Обёртка листа кончается вместе с содержимым, и ниже неё этот цвет проступал
 * в PDF пустым прямоугольником во всю печатную область. Видно это только на
 * готовом PDF, поэтому правило пришпилено проверкой.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('печать', () => {
  it('полотно белое', () => {
    const css = readFileSync(join(HERE, '..', '..', 'app.css'), 'utf8');
    expect(css).toMatch(/@media print \{\s*html,\s*body \{\s*background: #fff;/);
  });
});
