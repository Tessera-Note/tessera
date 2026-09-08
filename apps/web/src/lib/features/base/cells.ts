/**
 * Значение ячейки: чтение, показ и сравнение.
 *
 * Ячейки хранятся объектом `{идентификатор свойства: значение}`, и вид
 * значения задаёт свойство. Разбор один на все представления — таблицу, доску,
 * календарь и карточку строки: второй его список разошёлся бы с первым.
 *
 * Без единого импорта: разбор проверяется сам по себе.
 */

import type { Choice, PropertyType, SelectTypeOptions } from './types';

/** Кого показывает ячейка с человеком. */
export type Person = { id: string; name: string | null; avatarUrl: string | null };

/** Что показывает ячейка со ссылкой на страницу. */
export type PageRef = { id: string; slugId: string; title: string | null; icon: string | null };

/** Что известно показу сверх самой ячейки. */
export type CellContext = {
  people?: Record<string, Person>;
  pages?: Record<string, PageRef>;
};

/** Варианты выбора свойства в том порядке, в каком их задали. */
export function choicesOf(options: unknown): Choice[] {
  const typed = (options ?? {}) as SelectTypeOptions;
  const choices = typed.choices ?? [];
  const order = typed.choiceOrder;
  if (!order?.length) return choices;

  const byId = new Map(choices.map((one) => [one.id, one]));
  const sorted = order.map((id) => byId.get(id)).filter((one): one is Choice => Boolean(one));
  // Вариант, которого нет в порядке, теряться не должен: порядок и набор
  // правятся раздельно, и рассинхрон между ними — обычное дело.
  for (const one of choices) if (!order.includes(one.id)) sorted.push(one);
  return sorted;
}

/** Значения ячейки со множественным выбором всегда перечнем. */
export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((one) => String(one));
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

/**
 * Пуста ли ячейка.
 *
 * Пустая строка и пустой перечень считаются пустыми: отбор «не заполнено»
 * должен находить и их, иначе очищенная ячейка остаётся заполненной.
 */
export function isEmptyCell(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Ячейка строкой для показа и для сравнения.
 *
 * Одна функция на оба применения намеренно: отбор «содержит» ищет по тому же
 * тексту, что видит человек, и расхождение между показанным и найденным
 * читается как поломка отбора.
 */
export function cellText(
  value: unknown,
  type: PropertyType,
  typeOptions: unknown,
  context: CellContext = {}
): string {
  if (isEmptyCell(value)) return '';

  if (type === 'checkbox') return value === true ? 'true' : 'false';

  if (type === 'select' || type === 'status' || type === 'multiSelect') {
    const names = new Map(choicesOf(typeOptions).map((one) => [one.id, one.name]));
    return asList(value)
      .map((id) => names.get(id) ?? id)
      .join(', ');
  }

  if (type === 'person' || type === 'createdBy' || type === 'lastEditedBy') {
    return asList(value)
      .map((id) => context.people?.[id]?.name ?? id)
      .join(', ');
  }

  if (type === 'page') {
    return asList(value)
      .map((id) => context.pages?.[id]?.title ?? id)
      .join(', ');
  }

  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Значение ячейки для сравнения при сортировке.
 *
 * Числа сравниваются числами, даты — временем, остальное — текстом в нижнем
 * регистре. Пустая ячейка всегда уходит вниз, независимо от направления: она
 * не «меньше» и не «больше», её просто нет.
 */
export function sortKey(
  value: unknown,
  type: PropertyType,
  typeOptions: unknown,
  context: CellContext = {}
): number | string | null {
  if (isEmptyCell(value)) return null;

  if (type === 'number') {
    const made = Number(value);
    return Number.isFinite(made) ? made : null;
  }
  if (type === 'checkbox') return value === true ? 1 : 0;
  if (type === 'date' || type === 'createdAt' || type === 'lastEditedAt') {
    const made = new Date(String(value)).getTime();
    return Number.isNaN(made) ? null : made;
  }
  return cellText(value, type, typeOptions, context).toLowerCase();
}
