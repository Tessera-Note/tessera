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
  /** Язык показа дат. Берётся из выбора человека, а не из браузера. */
  locale?: string;
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

/**
 * Варианты в том порядке, в каком их показывать.
 *
 * По алфавиту, если свойство так настроено: набор пополняют по ходу работы, и
 * порядок заведения перестаёт быть порядком, в котором его удобно читать.
 */
export function shownChoices(options: unknown): Choice[] {
  const found = choicesOf(options);
  const wanted = (options ?? {}) as { alphabetize?: boolean };
  if (!wanted.alphabetize) return found;
  return [...found].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  );
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
 * Ячейка, которую не удалось посчитать.
 *
 * Формула сохранена верно, а данные строки не подошли: делить на ноль,
 * складывать дату со словом. Такая ячейка приходит объектом с кодом в `__err`,
 * и код — ключ перевода: показывать `msg` значило бы показывать английский
 * текст, написанный для разработчика.
 */
export function errorCode(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const found = (value as { __err?: unknown }).__err;
  return typeof found === 'string' ? found : null;
}

/**
 * Ключ перевода для кода ошибки.
 *
 * Ключи перечислены целиком, а не собираются подстановкой: проверка словарей
 * сверяет литералы, и собранный ключ она увидеть не может — недостающий
 * перевод дошёл бы до человека сырым ключом.
 */
const ERROR_KEYS: Record<string, string> = {
  MISSING_PROP: 'base.formula.error.MISSING_PROP',
  TYPE_MISMATCH: 'base.formula.error.TYPE_MISMATCH',
  DIV_BY_ZERO: 'base.formula.error.DIV_BY_ZERO',
  DATE_INVALID: 'base.formula.error.DATE_INVALID',
  DEPTH_EXCEEDED: 'base.formula.error.DEPTH_EXCEEDED',
  DEPENDENCY_ERROR: 'base.formula.error.DEPENDENCY_ERROR'
};

export function errorKey(value: unknown): string | null {
  const code = errorCode(value);
  return code ? (ERROR_KEYS[code] ?? null) : null;
}

/**
 * Настройки вида свойства.
 *
 * Число, дата и флажок показываются по-разному в зависимости от того, как
 * свойство настроено: без настроек вычисленное среднее выглядит как
 * `6.66333333333333`, а срок — как строка из базы.
 */
export type NumberOptions = {
  /** Как показывать: просто число, деньги или проценты. */
  format?: 'plain' | 'currency' | 'percent';
  /** Сколько знаков после запятой. Пусто — сколько есть. */
  precision?: number;
  /** Разделители: тысяч и дробной части. */
  separator?: 'comma-period' | 'period-comma' | 'space-comma' | 'space-period';
  /** Код валюты, если формат денежный. */
  currency?: string;
};

export type DateOptions = {
  /** Показывать ли время рядом с датой. */
  includeTime?: boolean;
  /** Двенадцать часов или двадцать четыре. */
  timeFormat?: '12' | '24';
};

/** Разделители по имени набора. Первый — тысяч, второй — дробной части. */
const SEPARATORS: Record<string, [string, string]> = {
  'comma-period': [',', '.'],
  'period-comma': ['.', ','],
  'space-comma': [' ', ','],
  'space-period': [' ', '.']
};

/** Настройки вида как объект. Негодное значение — это их отсутствие. */
function settings(typeOptions: unknown): Record<string, unknown> {
  return typeOptions && typeof typeOptions === 'object' && !Array.isArray(typeOptions)
    ? (typeOptions as Record<string, unknown>)
    : {};
}

/**
 * Число по настройкам свойства.
 *
 * Разделители подставляются сами, а не средствами языка вывода: набор выбирает
 * человек, и язык браузера читателя не должен менять вид таблицы, собранной
 * кем-то другим.
 */
export function numberText(value: number, typeOptions: unknown): string {
  const options = settings(typeOptions) as NumberOptions;
  const shown = options.format === 'percent' ? value * 100 : value;

  const precision = typeof options.precision === 'number' ? options.precision : null;
  let text = precision === null ? String(shown) : shown.toFixed(precision);

  const [thousands, decimal] = SEPARATORS[options.separator ?? 'comma-period'] ?? [',', '.'];
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);

  const [whole, fraction] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  text = fraction ? `${grouped}${decimal}${fraction}` : grouped;
  if (negative) text = `-${text}`;

  if (options.format === 'percent') return `${text}%`;
  if (options.format === 'currency') {
    const code = (options.currency || 'USD').toUpperCase();
    return `${text} ${code}`;
  }
  return text;
}

/**
 * Дата по настройкам свойства.
 *
 * Без времени по умолчанию: у срока время бессмысленно, а показанное «00:00»
 * читается как «в полночь».
 */
export function dateText(value: string, typeOptions: unknown, language?: string): string {
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return value;

  const options = settings(typeOptions) as DateOptions;
  const date = moment.toLocaleDateString(language);
  if (!options.includeTime) return date;

  const time = moment.toLocaleTimeString(language, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: options.timeFormat === '12'
  });
  return `${date} ${time}`;
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

  const failed = errorCode(value);
  if (failed) return `#${failed}`;

  if (type === 'file') {
    // Файлы лежат перечнем описаний. Показывается имя: адрес человеку ничего
    // не говорит, а в отборе «содержит» ищут именно по имени.
    return asList(value)
      .map((one) =>
        one && typeof one === 'object'
          ? String((one as { name?: unknown }).name ?? '')
          : String(one)
      )
      .filter(Boolean)
      .join(', ');
  }

  if (type === 'number' || type === 'formula') {
    const asNumber = typeof value === 'number' ? value : Number(value);
    if (typeof value !== 'object' && Number.isFinite(asNumber)) {
      return numberText(asNumber, typeOptions);
    }
  }

  if (type === 'date' && typeof value === 'string')
    return dateText(value, typeOptions, context.locale);

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
