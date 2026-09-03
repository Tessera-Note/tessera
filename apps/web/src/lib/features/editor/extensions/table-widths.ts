/**
 * Ширины столбцов у вставленной таблицы.
 *
 * В Markdown ширин нет вовсе. Без них таблица рисуется по `table-layout:
 * fixed` на всю ширину и сжимает столбцы под редактор вместо того, чтобы
 * прокручиваться внутри своей обёртки. Ширины поэтому выводятся из разметки, а
 * когда выводить не из чего — ставится одна и та же по умолчанию.
 *
 * Зеркало того, что делает сервер при ввозе (`import/utils/table-utils.ts` в
 * v1): одна и та же таблица должна выглядеть одинаково, приехала она файлом
 * или буфером обмена.
 */

/** Ширина столбца, когда вывести её неоткуда. */
const DEFAULT_WIDTH = 150;

function pixels(element: Element): number | null {
  const attribute = element.getAttribute('width');
  if (attribute) {
    const value = Number.parseInt(attribute, 10);
    if (Number.isFinite(value) && value > 0) return value;
  }

  const style = element.getAttribute('style') ?? '';
  const found = style.match(/(?:^|;)\s*width\s*:\s*([\d.]+)\s*px/i);
  if (found) {
    const value = Number.parseInt(found[1], 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** Первая строка таблицы, где бы она ни лежала. */
function firstRow(table: Element): Element | null {
  return (
    table.querySelector(':scope > tbody > tr') ??
    table.querySelector(':scope > thead > tr') ??
    table.querySelector(':scope > tr')
  );
}

function cellsOf(row: Element): Element[] {
  return [...row.children].filter((one) => one.tagName === 'TD' || one.tagName === 'TH');
}

function span(cell: Element): number {
  return Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1;
}

/** Ширины из разметки: сперва `colgroup`, потом первая строка. */
function derive(table: Element): (number | null)[] | null {
  const columns = [...table.querySelectorAll(':scope > colgroup > col')];
  if (columns.length > 0) {
    const widths = columns.map((one) => pixels(one));
    if (widths.some((one) => one !== null)) return widths;
  }

  const row = firstRow(table);
  if (!row) return null;

  const widths: (number | null)[] = [];
  for (const cell of cellsOf(row)) {
    const across = span(cell);
    const width = pixels(cell);
    for (let i = 0; i < across; i += 1) {
      widths.push(width !== null ? Math.round(width / across) : null);
    }
  }
  if (widths.length === 0 || widths.every((one) => one === null)) return null;
  return widths;
}

/** Проставить `colwidth` каждой ячейке первой строки. */
export function normalizeTableColumnWidths(root: Element): void {
  for (const table of root.querySelectorAll('table')) {
    const row = firstRow(table);
    if (!row) continue;

    let widths = derive(table);
    if (!widths) {
      const count = cellsOf(row).reduce((sum, cell) => sum + span(cell), 0);
      if (count === 0) continue;
      widths = new Array<number | null>(count).fill(DEFAULT_WIDTH);
    }

    let at = 0;
    for (const cell of cellsOf(row)) {
      const across = span(cell);
      // Уже проставленное не трогаем: оно пришло из разметки и точнее нашего.
      if (cell.getAttribute('colwidth')) {
        at += across;
        continue;
      }
      const slice = widths.slice(at, at + across);
      at += across;
      if (slice.length === 0 || slice.every((one) => one === null)) continue;
      cell.setAttribute('colwidth', slice.map((one) => one ?? 100).join(','));
    }
  }
}

/**
 * Вставленное — это один голый адрес?
 *
 * Тогда разбирать его как Markdown не надо: расширение ссылок само сделает из
 * него ссылку, а разбор превратил бы адрес со скобками в поломанную разметку.
 *
 * Проверка своя, а не библиотекой распознавания ссылок: она не объявлена ни в
 * одном составе зависимостей этого проекта, а нужен здесь один вопрос — один
 * ли это адрес целиком.
 */
export function isBareLink(text: string): boolean {
  const one = text.trim();
  if (!one || /\s/.test(one)) return false;

  try {
    const address = new URL(one.includes('://') ? one : `http://${one}`);
    return address.hostname.includes('.') && !address.hostname.endsWith('.');
  } catch {
    return false;
  }
}
