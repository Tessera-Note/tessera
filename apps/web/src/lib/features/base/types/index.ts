/**
 * Устройство базы: виды свойств, настройки представления, отборы.
 *
 * Формы перенесены из первой версии дословно. Совпадение обязательно:
 * настройки представления лежат в общей базе колонкой `config`, и своя форма
 * означала бы, что представление, настроенное во второй версии, в первой
 * читается пустым.
 *
 * Без единого импорта: разбор отбора проверяется сам по себе.
 */

/** Виды свойств. Значения понимает сервер (`PROPERTY_TYPES`). */
export type PropertyType =
  | 'title'
  | 'text'
  | 'longText'
  | 'number'
  | 'select'
  | 'status'
  | 'multiSelect'
  | 'date'
  | 'person'
  | 'file'
  | 'page'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'createdAt'
  | 'lastEditedAt'
  | 'createdBy'
  | 'lastEditedBy'
  | 'formula';

export type ViewType = 'table' | 'kanban' | 'calendar';

/**
 * Вычисляемые свойства: значение ставит сервер, человек его не правит.
 *
 * Поле ввода у них означало бы обещание правки, которую сервер отвергает.
 */
export const COMPUTED_TYPES: readonly PropertyType[] = [
  'createdAt',
  'lastEditedAt',
  'createdBy',
  'lastEditedBy',
  'formula'
];

/** Вариант выбора у свойств `select`, `status` и `multiSelect`. */
export type Choice = {
  id: string;
  name: string;
  color?: string;
  category?: 'todo' | 'inProgress' | 'complete';
};

export type SelectTypeOptions = {
  choices?: Choice[];
  choiceOrder?: string[];
  disableColors?: boolean;
  defaultValue?: string | string[] | null;
};

export type DateTypeOptions = {
  includeTime?: boolean;
  defaultValue?: string | null;
};

export type PersonTypeOptions = {
  allowMultiple?: boolean;
  defaultValue?: string | string[] | null;
};

export type NumberTypeOptions = {
  format?: 'plain' | 'currency' | 'percent' | 'progress';
  precision?: number;
  currencySymbol?: string;
  defaultValue?: number | null;
};

/** Направление сортировки представления. */
export type SortConfig = { propertyId: string; direction: 'asc' | 'desc' };

/** Действия отбора. Набор тот же, что понимает движок v1. */
export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'ncontains'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'before'
  | 'after'
  | 'onOrBefore'
  | 'onOrAfter'
  | 'any'
  | 'none'
  | 'all';

export type FilterCondition = { propertyId: string; op: FilterOperator; value?: unknown };
export type FilterGroup = { op: 'and' | 'or'; children: FilterNode[] };
export type FilterNode = FilterCondition | FilterGroup;

export function isGroup(node: FilterNode): node is FilterGroup {
  return 'children' in node;
}

/** Настройки представления. Лежат в колонке `config` записи представления. */
export type ViewConfig = {
  sorts?: SortConfig[];
  filter?: FilterGroup;
  visiblePropertyIds?: string[];
  hiddenPropertyIds?: string[];
  propertyOrder?: string[];
  groupByPropertyId?: string;
  hiddenChoiceIds?: string[];
  choiceOrder?: string[];
  /**
   * Что показывать на карточке доски.
   *
   * Пусто — первые три свойства подряд: у базы, где их пять, выбирать нечего,
   * и заставлять человека настраивать доску до первого её показа незачем.
   */
  cardPropertyIds?: string[];
  /** Свойство с датой, по которому раскладывается календарь. */
  datePropertyId?: string;
};

/** Ключ столбца доски для строк без значения. Совпадает с v1. */
export const NO_VALUE_CHOICE_ID = '__no_value';
