/**
 * Ширины столбцов вставленной таблицы и распознавание голого адреса.
 *
 * В Markdown ширин нет: без них таблица сжимается под редактор вместо того,
 * чтобы прокручиваться. Проверяется, что ширины выводятся из разметки, а когда
 * выводить не из чего — ставится одна и та же.
 */

import { describe, expect, it } from 'vitest';
import { isBareLink, normalizeTableColumnWidths } from './table-widths';

function build(html: string): HTMLElement {
  const body = document.createElement('div');
  body.innerHTML = html;
  return body;
}

function widths(root: HTMLElement): (string | null)[] {
  const row = root.querySelector('tr');
  return [...(row?.children ?? [])].map((one) => one.getAttribute('colwidth'));
}

describe('normalizeTableColumnWidths', () => {
  it('берёт ширины из colgroup', () => {
    const root = build(
      '<table><colgroup><col width="200"><col width="300"></colgroup>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody></table>'
    );
    normalizeTableColumnWidths(root);
    expect(widths(root)).toEqual(['200', '300']);
  });

  it('берёт ширины из стиля первой строки', () => {
    const root = build(
      '<table><tbody><tr><td style="width: 120px">a</td><td style="width:80px">b</td></tr></tbody></table>'
    );
    normalizeTableColumnWidths(root);
    expect(widths(root)).toEqual(['120', '80']);
  });

  it('без ширин в разметке ставит одну и ту же', () => {
    const root = build('<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>');
    normalizeTableColumnWidths(root);
    expect(widths(root)).toEqual(['150', '150', '150']);
  });

  it('делит ширину объединённой ячейки на её столбцы', () => {
    const root = build(
      '<table><tbody><tr><td colspan="2" width="300">a</td><td width="100">b</td></tr></tbody></table>'
    );
    normalizeTableColumnWidths(root);
    expect(widths(root)).toEqual(['150,150', '100']);
  });

  it('уже проставленное не трогает', () => {
    // Оно пришло из разметки и точнее выведенного.
    const root = build('<table><tbody><tr><td colwidth="77">a</td><td>b</td></tr></tbody></table>');
    normalizeTableColumnWidths(root);
    expect(widths(root)).toEqual(['77', '150']);
  });

  it('шапку берёт за первую строку, когда тела нет', () => {
    const root = build('<table><thead><tr><th>a</th><th>b</th></tr></thead></table>');
    normalizeTableColumnWidths(root);
    expect(widths(root)).toEqual(['150', '150']);
  });

  it('таблицу без строк оставляет как есть', () => {
    const root = build('<table></table>');
    expect(() => normalizeTableColumnWidths(root)).not.toThrow();
  });
});

describe('isBareLink', () => {
  it('узнаёт адрес со схемой и без', () => {
    expect(isBareLink('https://example.com/страница')).toBe(true);
    expect(isBareLink('example.com')).toBe(true);
    expect(isBareLink('  https://example.com  ')).toBe(true);
  });

  it('текст с пробелами адресом не считает', () => {
    // Иначе «см. https://example.com» разбиралось бы как ссылка целиком.
    expect(isBareLink('см. https://example.com')).toBe(false);
  });

  it('обычное слово адресом не считает', () => {
    expect(isBareLink('заголовок')).toBe(false);
    expect(isBareLink('')).toBe(false);
    expect(isBareLink('# Заголовок')).toBe(false);
  });
});
