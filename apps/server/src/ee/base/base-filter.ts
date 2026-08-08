/**
 * Вычисление фильтров представления base.
 *
 * Клиент объявляет набор операторов в `apps/client/src/ee/base/types/base.types.ts`
 * (`FilterOperator`) и предлагает их пользователю через реестр типов свойств.
 * Раньше сервер понимал четыре оператора из двадцати, а на остальных возвращал
 * `true`, то есть молча пропускал все строки вместо фильтрации.
 *
 * Даты сравниваются с точностью до календарного дня в UTC. Часового пояса
 * пользователя на сервере нет, а клиент для точной даты присылает `YYYY-MM-DD`,
 * поэтому день это единственная granularity, одинаковая на обеих сторонах.
 * Начало недели понедельник.
 */

export type BaseFilterCondition = {
  propertyId?: string;
  op?: string;
  value?: unknown;
};

export type BaseFilterGroup = {
  op?: 'and' | 'or' | string;
  children?: unknown[];
};

export type BaseFilterNode = BaseFilterCondition | BaseFilterGroup;

type DayRange = { start: string; end: string };

const DAY_MS = 24 * 60 * 60 * 1000;

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Календарный день значения в UTC, `YYYY-MM-DD`, либо null. */
function toDay(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || value === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function shiftMonths(date: Date, months: number): Date {
  const shifted = new Date(date.getTime());
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  return shifted;
}

function shiftYears(date: Date, years: number): Date {
  const shifted = new Date(date.getTime());
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return shifted;
}

/** Понедельник недели, содержащей дату. */
function startOfWeek(date: Date): Date {
  const weekday = date.getUTCDay();
  const offset = weekday === 0 ? 6 : weekday - 1;
  return shiftDays(date, -offset);
}

function resolveAnchor(preset: string, now: Date): string | null {
  switch (preset) {
    case 'today':
      return dayOf(now);
    case 'tomorrow':
      return dayOf(shiftDays(now, 1));
    case 'yesterday':
      return dayOf(shiftDays(now, -1));
    case 'oneWeekAgo':
      return dayOf(shiftDays(now, -7));
    case 'oneWeekFromNow':
      return dayOf(shiftDays(now, 7));
    case 'oneMonthAgo':
      return dayOf(shiftMonths(now, -1));
    case 'oneMonthFromNow':
      return dayOf(shiftMonths(now, 1));
    default:
      return null;
  }
}

function resolveRange(preset: string, now: Date): DayRange | null {
  switch (preset) {
    case 'pastWeek':
      return { start: dayOf(shiftDays(now, -7)), end: dayOf(now) };
    case 'pastMonth':
      return { start: dayOf(shiftMonths(now, -1)), end: dayOf(now) };
    case 'pastYear':
      return { start: dayOf(shiftYears(now, -1)), end: dayOf(now) };
    case 'nextWeek':
      return { start: dayOf(now), end: dayOf(shiftDays(now, 7)) };
    case 'nextMonth':
      return { start: dayOf(now), end: dayOf(shiftMonths(now, 1)) };
    case 'nextYear':
      return { start: dayOf(now), end: dayOf(shiftYears(now, 1)) };
    case 'thisWeek': {
      const monday = startOfWeek(now);
      return { start: dayOf(monday), end: dayOf(shiftDays(monday, 6)) };
    }
    case 'thisMonth': {
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      const start = new Date(Date.UTC(year, month, 1));
      const end = new Date(Date.UTC(year, month + 1, 0));
      return { start: dayOf(start), end: dayOf(end) };
    }
    case 'thisYear': {
      const year = now.getUTCFullYear();
      return {
        start: dayOf(new Date(Date.UTC(year, 0, 1))),
        end: dayOf(new Date(Date.UTC(year, 11, 31))),
      };
    }
    default:
      return null;
  }
}

/**
 * День, с которым сравнивается ячейка. Принимает и объект `DateFilterValue`
 * клиента, и голую строку даты: часть вызывающего кода хранит именно строку.
 */
function expectedDay(expected: unknown, now: Date): string | null {
  if (typeof expected === 'string') return toDay(expected);
  if (!expected || typeof expected !== 'object') return null;

  const value = expected as { mode?: string; date?: unknown; preset?: unknown };
  if (value.mode === 'exact') return toDay(value.date);
  if (value.mode === 'relative' && typeof value.preset === 'string') {
    return resolveAnchor(value.preset, now);
  }
  return null;
}

function expectedRange(expected: unknown, now: Date): DayRange | null {
  if (!expected || typeof expected !== 'object') return null;
  const value = expected as { mode?: string; preset?: unknown };
  if (value.mode === 'range' && typeof value.preset === 'string') {
    return resolveRange(value.preset, now);
  }
  return null;
}

/** Сравнение на равенство, устойчивое к разнице числа и его строки. */
function looseEquals(cell: unknown, expected: unknown): boolean {
  if (cell === expected) return true;

  const cellNumber = toNumber(cell);
  const expectedNumber = toNumber(expected);
  if (cellNumber !== null && expectedNumber !== null) {
    return cellNumber === expectedNumber;
  }

  const cellText = toText(cell);
  const expectedText = toText(expected);
  if (cellText !== null && expectedText !== null) {
    return cellText === expectedText;
  }

  return false;
}

function includesText(cell: unknown, expected: unknown): boolean {
  const needle = toText(expected);
  if (needle === null || needle === '') return true;
  const lowered = needle.toLowerCase();

  return toArray(cell).some((item) => {
    const text = toText(item);
    return text !== null && text.toLowerCase().includes(lowered);
  });
}

function compareOrdered(cell: unknown, expected: unknown): number | null {
  const cellNumber = toNumber(cell);
  const expectedNumber = toNumber(expected);
  if (cellNumber !== null && expectedNumber !== null) {
    return cellNumber === expectedNumber
      ? 0
      : cellNumber > expectedNumber
        ? 1
        : -1;
  }

  const cellText = toText(cell);
  const expectedText = toText(expected);
  if (cellText !== null && expectedText !== null) {
    return cellText === expectedText ? 0 : cellText > expectedText ? 1 : -1;
  }

  return null;
}

function matchesCondition(
  cell: unknown,
  op: string,
  expected: unknown,
  now: Date,
): boolean {
  switch (op) {
    case 'isEmpty':
      return isEmptyValue(cell);
    case 'isNotEmpty':
      return !isEmptyValue(cell);
    default:
      break;
  }

  switch (op) {
    case 'eq': {
      const day = expectedDay(expected, now);
      if (day !== null && typeof expected === 'object') {
        return toDay(cell) === day;
      }
      return looseEquals(cell, expected);
    }
    case 'neq': {
      const day = expectedDay(expected, now);
      if (day !== null && typeof expected === 'object') {
        return toDay(cell) !== day;
      }
      return !looseEquals(cell, expected);
    }

    case 'contains':
      return includesText(cell, expected);
    case 'ncontains': {
      // Незаданная подстрока это отсутствие ограничения. Без этой ветки
      // отрицание includesText прятало бы вообще все строки, а клиент при
      // смене оператора сохраняет условие с пустым значением.
      const needle = toText(expected);
      if (needle === null || needle === '') return true;
      return !includesText(cell, expected);
    }
    case 'startsWith':
    case 'endsWith': {
      const needle = toText(expected);
      if (needle === null || needle === '') return true;
      const lowered = needle.toLowerCase();
      return toArray(cell).some((item) => {
        const text = toText(item);
        if (text === null) return false;
        const value = text.toLowerCase();
        return op === 'startsWith'
          ? value.startsWith(lowered)
          : value.endsWith(lowered);
      });
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const comparison = compareOrdered(cell, expected);
      if (comparison === null) return false;
      if (op === 'gt') return comparison > 0;
      if (op === 'gte') return comparison >= 0;
      if (op === 'lt') return comparison < 0;
      return comparison <= 0;
    }

    case 'any':
    case 'none':
    case 'all': {
      const cellValues = toArray(cell);
      const expectedValues = toArray(expected);
      // Пустой список в условии это отсутствие ограничения, а не запрет.
      if (expectedValues.length === 0) return true;

      if (op === 'all') {
        return expectedValues.every((wanted) =>
          cellValues.some((actual) => looseEquals(actual, wanted)),
        );
      }

      const intersects = expectedValues.some((wanted) =>
        cellValues.some((actual) => looseEquals(actual, wanted)),
      );
      return op === 'any' ? intersects : !intersects;
    }

    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter': {
      const cellDay = toDay(cell);
      const day = expectedDay(expected, now);
      if (cellDay === null || day === null) return false;
      if (op === 'before') return cellDay < day;
      if (op === 'after') return cellDay > day;
      if (op === 'onOrBefore') return cellDay <= day;
      return cellDay >= day;
    }

    case 'isWithin': {
      const cellDay = toDay(cell);
      const range = expectedRange(expected, now);
      if (cellDay === null || range === null) return false;
      return cellDay >= range.start && cellDay <= range.end;
    }

    default:
      // Неизвестный оператор не должен молча пропускать строку: это ровно то
      // поведение, из-за которого фильтры выглядели работающими, но не были.
      return false;
  }
}

/**
 * Проходит ли строка фильтр представления.
 *
 * `now` вынесен в параметр, чтобы относительные даты были воспроизводимы
 * в тестах.
 */
export function matchesBaseRowFilter(
  cells: Record<string, unknown>,
  filter: unknown,
  now: Date = new Date(),
): boolean {
  if (!filter || typeof filter !== 'object') return true;

  const node = filter as BaseFilterCondition & BaseFilterGroup;

  if (Array.isArray(node.children)) {
    if (node.children.length === 0) return true;
    return node.op === 'or'
      ? node.children.some((child) => matchesBaseRowFilter(cells, child, now))
      : node.children.every((child) => matchesBaseRowFilter(cells, child, now));
  }

  if (typeof node.propertyId !== 'string' || typeof node.op !== 'string') {
    return true;
  }

  return matchesCondition(cells?.[node.propertyId], node.op, node.value, now);
}

/**
 * Дешёвое подмножество фильтра, которое умеет посчитать сама база.
 *
 * Полная трансляция всех двадцати операторов в SQL не нужна: относительные
 * даты и множества дешевле досчитать в приложении на уже суженном наборе.
 * Сюда попадают только условия, сужающие выборку одним предикатом по ячейке,
 * и только внутри группы `and`: внутри `or` частичное сужение отбросило бы
 * строки, которые прошли бы по другой ветке.
 *
 * Возвращает список условий, каждое из которых можно применить как отдельный
 * `WHERE`. Пустой список означает, что сузить нечем.
 */
export type PushdownCondition = {
  propertyId: string;
  op: 'eq' | 'isEmpty' | 'isNotEmpty' | 'contains';
  value?: string;
};

export function collectPushdownConditions(
  filter: unknown,
): PushdownCondition[] {
  if (!filter || typeof filter !== 'object') return [];

  const node = filter as BaseFilterCondition & BaseFilterGroup;

  if (Array.isArray(node.children)) {
    // Только конъюнкция: в дизъюнкции сужение по одной ветке потеряет строки.
    if (node.op === 'or') return [];
    return node.children.flatMap((child) => collectPushdownConditions(child));
  }

  if (typeof node.propertyId !== 'string' || typeof node.op !== 'string') {
    return [];
  }

  switch (node.op) {
    case 'isEmpty':
    case 'isNotEmpty':
      return [{ propertyId: node.propertyId, op: node.op }];

    case 'eq': {
      // Даты и объекты в SQL не уходят: их семантика в вычислителе сложнее
      // равенства строк.
      const text = toText(node.value);
      if (text === null) return [];
      return [{ propertyId: node.propertyId, op: 'eq', value: text }];
    }

    case 'contains': {
      const text = toText(node.value);
      if (text === null || text === '') return [];
      return [{ propertyId: node.propertyId, op: 'contains', value: text }];
    }

    default:
      return [];
  }
}
