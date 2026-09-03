/**
 * Отбор, порядок и состав колонок представления.
 *
 * **Считается здесь, а не на сервере.** Маршрут `bases/rows` отдаёт строки по
 * позиции и настроек представления не знает вовсе — движка отбора на стороне
 * второй версии нет. Поэтому отбор и сортировка применяются к уже загруженным
 * строкам, и это осознанное ограничение: пока не загружены все страницы
 * выдачи, отобрано будет только загруженное. Кнопка «ещё» рядом с таблицей
 * остаётся ровно поэтому.
 *
 * Без единого импорта, кроме типов: разбор проверяется сам по себе.
 */

import { cellText, isEmptyCell, sortKey, type CellContext } from './cells';
import { isGroup, type FilterNode, type PropertyType, type ViewConfig } from './types';

/** Свойство в объёме, нужном отбору. */
export type Column = {
  id: string;
  name: string;
  type: PropertyType;
  position: string;
  typeOptions: unknown;
  isPrimary: boolean;
};

/** Строка в объёме, нужном отбору. */
export type Row = { id: string; cells: Record<string, unknown>; position: string };

/**
 * Колонки представления: скрытые убраны, остальные в заданном порядке.
 *
 * Порядок задаётся `propertyOrder`; свойство, которого в нём нет, встаёт после
 * перечисленных в своём исходном порядке — иначе заведённое соседом свойство
 * пропадало бы у всех, кто уже настроил порядок.
 */
export function visibleColumns(columns: readonly Column[], config: ViewConfig): Column[] {
  const hidden = new Set(config.hiddenPropertyIds ?? []);
  // Первичное свойство не прячется: без него строка теряет название, и
  // карточку строки не открыть.
  const shown = columns.filter((one) => one.isPrimary || !hidden.has(one.id));

  const order = config.propertyOrder;
  if (!order?.length) return shown;

  const byId = new Map(shown.map((one) => [one.id, one]));
  const sorted: Column[] = [];
  for (const id of order) {
    const found = byId.get(id);
    if (found) {
      sorted.push(found);
      byId.delete(id);
    }
  }
  for (const one of shown) if (byId.has(one.id)) sorted.push(one);
  return sorted;
}

/** Подходит ли строка отбору. Пустой отбор подходит всему. */
export function matches(
  row: Row,
  node: FilterNode | undefined,
  columns: readonly Column[],
  context: CellContext = {}
): boolean {
  if (!node) return true;

  if (isGroup(node)) {
    if (node.children.length === 0) return true;
    return node.op === 'or'
      ? node.children.some((child) => matches(row, child, columns, context))
      : node.children.every((child) => matches(row, child, columns, context));
  }

  const column = columns.find((one) => one.id === node.propertyId);
  if (!column) return true;

  const raw = row.cells[node.propertyId];
  const empty = isEmptyCell(raw);

  if (node.op === 'isEmpty') return empty;
  if (node.op === 'isNotEmpty') return !empty;
  // Пустая ячейка не подходит ни одному условию сравнения: «не равно» на
  // пустоте означало бы, что незаполненная строка попадает во все отборы.
  if (empty) return false;

  const text = cellText(raw, column.type, column.typeOptions, context).toLowerCase();
  const wanted = node.value;
  const wantedText = wanted === null || wanted === undefined ? '' : String(wanted).toLowerCase();

  switch (node.op) {
    case 'eq':
      return text === wantedText;
    case 'neq':
      return text !== wantedText;
    case 'contains':
      return text.includes(wantedText);
    case 'ncontains':
      return !text.includes(wantedText);
    case 'startsWith':
      return text.startsWith(wantedText);
    case 'endsWith':
      return text.endsWith(wantedText);
    case 'any':
      return listOf(raw).some((one) => String(one) === String(wanted));
    case 'none':
      return !listOf(raw).some((one) => String(one) === String(wanted));
    case 'all':
      return listOf(wanted).every((one) => listOf(raw).includes(one));
    default:
      return compare(node.op, raw, wanted, column, context);
  }
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((one) => String(one));
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

/** Сравнения по величине: числа, даты и всё, что сводится к тексту. */
function compare(
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'before' | 'after' | 'onOrBefore' | 'onOrAfter',
  raw: unknown,
  wanted: unknown,
  column: Column,
  context: CellContext
): boolean {
  const left = sortKey(raw, column.type, column.typeOptions, context);
  const right = sortKey(wanted, column.type, column.typeOptions, context);
  if (left === null || right === null) return false;

  if (op === 'gt' || op === 'after') return left > right;
  if (op === 'gte' || op === 'onOrAfter') return left >= right;
  if (op === 'lt' || op === 'before') return left < right;
  return left <= right;
}

/**
 * Упорядочить строки.
 *
 * Без сортировок порядок остаётся тем, что задан позициями: его человек
 * расставил руками, и перекладывать его без просьбы нельзя.
 *
 * Пустые ячейки всегда внизу, при любом направлении: пустая ячейка не больше
 * и не меньше, её просто нет, и всплывающая наверх пустота читается как
 * поломка сортировки.
 */
export function sortRows(
  rows: readonly Row[],
  config: ViewConfig,
  columns: readonly Column[],
  context: CellContext = {}
): Row[] {
  const sorts = config.sorts ?? [];
  if (sorts.length === 0) return [...rows];

  const byId = new Map(columns.map((one) => [one.id, one]));
  return [...rows].sort((left, right) => {
    for (const one of sorts) {
      const column = byId.get(one.propertyId);
      if (!column) continue;

      const a = sortKey(left.cells[one.propertyId], column.type, column.typeOptions, context);
      const b = sortKey(right.cells[one.propertyId], column.type, column.typeOptions, context);
      if (a === b) continue;
      if (a === null) return 1;
      if (b === null) return -1;

      const step = a < b ? -1 : 1;
      return one.direction === 'desc' ? -step : step;
    }
    // При равенстве по всем сортировкам порядок остаётся исходным.
    return left.position < right.position ? -1 : left.position > right.position ? 1 : 0;
  });
}

/** Строки представления: отобранные и упорядоченные. */
export function viewRows(
  rows: readonly Row[],
  config: ViewConfig,
  columns: readonly Column[],
  context: CellContext = {}
): Row[] {
  const kept = rows.filter((row) => matches(row, config.filter, columns, context));
  return sortRows(kept, config, columns, context);
}

/**
 * Какое представление показать после перечитывания данных.
 *
 * Уже выбранное переживает перечитывание: правка ячейки перечитывает базу
 * целиком, и сброс на первое выбрасывал бы человека из открытого
 * представления после каждой правки. Первое берётся, только когда выбранного
 * больше нет — его удалили здесь же или рядом.
 */
export function chooseView(
  views: readonly { id: string }[],
  current: string | null
): string | null {
  if (current !== null && views.some((one) => one.id === current)) return current;
  return views[0]?.id ?? null;
}
