import { apiBase } from '$lib/api/base';
import { ApiError, post } from '$lib/api/client';

import type { PropertyType, ViewConfig, ViewType } from '$lib/features/base/types';

export type BaseProperty = {
  id: string;
  name: string;
  type: PropertyType;
  position: string;
  typeOptions: Record<string, unknown> | null;
  isPrimary: boolean;
};

export type BaseView = {
  id: string;
  name: string;
  type: ViewType;
  position: string;
  config: ViewConfig;
};

export type BaseInfo = {
  id: string;
  slugId: string;
  name: string | null;
  icon: string | null;
  spaceId: string;
  baseSchemaVersion: number;
  properties: BaseProperty[];
  views: BaseView[];
  permissions: { canEdit: boolean; canView: boolean };
};

export type BaseRow = {
  id: string;
  pageId: string;
  cells: Record<string, unknown>;
  position: string;
  creatorId: string | null;
  lastUpdatedById: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type RowPage = {
  items: BaseRow[];
  nextCursor: string | null;
  references: { users: { id: string; name: string | null; avatarUrl: string | null }[] };
};

/**
 * Виды свойств. Значения понимает сервер, подписи видит человек.
 *
 * Перечислены не все девятнадцать. `title` заводит только сервер — при
 * заведении базы и при превращении страницы в базу; второе такое свойство
 * означало бы две колонки названия. Остальные восемнадцать здесь: у файла есть
 * ячейка с загрузкой, у формулы — поле выражения в настройках свойства.
 */
export const PROPERTY_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'longText', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select' },
  { value: 'status', label: 'Status' },
  { value: 'multiSelect', label: 'Multi-select' },
  { value: 'person', label: 'Person' },
  { value: 'file', label: 'File' },
  { value: 'formula', label: 'Formula' },
  { value: 'page', label: 'Page' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
  { value: 'createdAt', label: 'Created time' },
  { value: 'lastEditedAt', label: 'Last edited time' },
  { value: 'createdBy', label: 'Created by' },
  { value: 'lastEditedBy', label: 'Last edited by' }
] as const;

/** Виды представления. Значения понимает сервер (`VIEW_TYPES`). */
export const VIEW_TYPES = [
  { value: 'table', label: 'Table' },
  { value: 'kanban', label: 'Board' },
  { value: 'calendar', label: 'Calendar' }
] as const;

export function baseInfo(baseId: string, fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<BaseInfo>('/api/bases/info', { baseId }, { fetcher, headers });
}

export function baseRows(
  baseId: string,
  cursor?: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<RowPage>('/api/bases/rows', { baseId, cursor }, { fetcher, headers });
}

/**
 * Завести базу.
 *
 * `parentPageId` привязывает базу к странице: так её заводит встраивание из
 * редактора. `template: 'kanban'` просит сервер сразу добавить свойство
 * состояния и представление доской — руками это четыре запроса подряд.
 */
export function createBase(
  values: { spaceId?: string; parentPageId?: string; name?: string; template?: 'kanban' },
  fetcher?: typeof fetch
) {
  return post<{ id: string }>('/api/bases/create', values, { fetcher });
}

/**
 * Превратить страницу в базу.
 *
 * Так базу заводят из пустой страницы: `template: 'kanban'` просит сразу доску
 * со свойством состояния, иначе выходит таблица. Обратного превращения нет —
 * оно потеряло бы свойства и строки.
 */
export function convertToBase(pageId: string, template?: 'kanban', fetcher?: typeof fetch) {
  return post<BaseInfo>('/api/bases/convert', { pageId, template }, { fetcher });
}

/** Убрать базу в корзину вместе со строками. */
export function deleteBase(baseId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/bases/delete', { baseId }, { fetcher });
}

export function renameBase(baseId: string, name: string, fetcher?: typeof fetch) {
  return post<BaseInfo>('/api/bases/update', { baseId, name }, { fetcher });
}

export function createProperty(
  values: { baseId: string; name: string; type: string },
  fetcher?: typeof fetch
) {
  return post<BaseProperty>('/api/bases/properties/create', values, { fetcher });
}

/**
 * Изменить свойство.
 *
 * `clearTypeOptions` отдельным признаком, а не пустым объектом: пустой объект
 * и отсутствие настроек — разные состояния, и сбросить настройки иначе нечем.
 */
export function updateProperty(
  values: {
    baseId: string;
    propertyId: string;
    name?: string;
    type?: string;
    typeOptions?: Record<string, unknown>;
    clearTypeOptions?: boolean;
  },
  fetcher?: typeof fetch
) {
  return post<BaseProperty>('/api/bases/properties/update', values, { fetcher });
}

/** Переставить колонку. Позиция это дробный ключ между соседями. */
export function reorderProperty(
  baseId: string,
  propertyId: string,
  position: string,
  fetcher?: typeof fetch
) {
  return post<BaseProperty>(
    '/api/bases/properties/reorder',
    { baseId, propertyId, position },
    { fetcher }
  );
}

export function deleteProperty(baseId: string, propertyId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>(
    '/api/bases/properties/delete',
    { baseId, propertyId },
    { fetcher }
  );
}

export function createRow(baseId: string, fetcher?: typeof fetch) {
  return post<BaseRow>('/api/bases/rows/create', { baseId }, { fetcher });
}

/**
 * Изменить часть ячеек.
 *
 * Отправляются только изменённые: слияние делает база, и запись строки целиком
 * затирала бы правку соседа в другой ячейке. `null` очищает ячейку.
 */
export function updateRow(
  baseId: string,
  rowId: string,
  cells: Record<string, unknown>,
  fetcher?: typeof fetch
) {
  return post<BaseRow>('/api/bases/rows/update', { baseId, rowId, cells }, { fetcher });
}

/** Переставить строку. Позиция это дробный ключ между соседями. */
export function reorderRow(
  baseId: string,
  rowId: string,
  position: string,
  fetcher?: typeof fetch
) {
  return post<BaseRow>('/api/bases/rows/reorder', { baseId, rowId, position }, { fetcher });
}

/** Одна строка. Люди и страницы к ней разворачиваются отдельно. */
export function rowInfo(baseId: string, rowId: string, fetcher?: typeof fetch) {
  return post<BaseRow>('/api/bases/rows/info', { baseId, rowId }, { fetcher });
}

/** Названия страниц для ячеек со ссылками. */
export function expandPages(pageIds: string[], fetcher?: typeof fetch) {
  return post<{ id: string; slugId: string; title: string | null; icon: string | null }[]>(
    '/api/bases/pages/expand',
    { pageIds },
    { fetcher }
  );
}

export function deleteRow(baseId: string, rowId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/bases/rows/delete', { baseId, rowId }, { fetcher });
}

/**
 * Предел одной просьбы об удалении. Столько же берёт сервер.
 *
 * Лишнее сервер отбрасывает молча, поэтому делит перечень клиент: иначе выбор
 * из тысячи строк убрал бы пятьсот, а человеку сообщили бы про тысячу.
 */
const DELETE_MANY_LIMIT = 500;

/** Убрать выбранные строки. Возвращает, сколько их убралось на самом деле. */
export async function deleteRows(
  baseId: string,
  rowIds: string[],
  fetcher?: typeof fetch
): Promise<number> {
  let deleted = 0;
  for (let at = 0; at < rowIds.length; at += DELETE_MANY_LIMIT) {
    const portion = rowIds.slice(at, at + DELETE_MANY_LIMIT);
    const answer = await post<{ deleted: number }>(
      '/api/bases/rows/delete-many',
      { baseId, rowIds: portion },
      { fetcher }
    );
    deleted += answer.deleted ?? 0;
  }
  return deleted;
}

export function createView(
  baseId: string,
  name: string,
  type: string = 'table',
  fetcher?: typeof fetch
) {
  return post<BaseView>('/api/bases/views/create', { baseId, name, type }, { fetcher });
}

/**
 * Изменить представление.
 *
 * Настройки отдаются целиком, а не по частям: сервер записывает `config` как
 * есть, и отправка одного поля стёрла бы остальные.
 */
export function updateView(
  values: { baseId: string; viewId: string; name?: string; type?: string; config?: ViewConfig },
  fetcher?: typeof fetch
) {
  return post<BaseView>('/api/bases/views/update', values, { fetcher });
}

export function deleteView(baseId: string, viewId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/bases/views/delete', { baseId, viewId }, { fetcher });
}

/**
 * Выгрузить строки файлом CSV.
 *
 * Через запрос, а не ссылкой: маршрут отвечает на `POST` с телом, и обычная
 * ссылка на него ведёт в отказ. Файл собирается в памяти браузера — сервер
 * держит для него тот же предел, что и на выгрузку целиком.
 */
export async function exportCsv(baseId: string, fileName: string): Promise<void> {
  const response = await fetch(`${apiBase()}/api/bases/export-csv`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseId })
  });

  if (!response.ok) {
    const body = await response.text();
    let code = 'error.common.unknown';
    let message = '';
    try {
      const parsed = JSON.parse(body) as { code?: string; message?: string };
      code = parsed.code ?? code;
      message = parsed.message ?? '';
    } catch {
      // Тело не разобралось: отвечает не наш сервер, а что-то на его месте.
    }
    throw new ApiError(response.status, code, message, {});
  }

  const blob = await response.blob();
  const address = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = address;
  link.download = fileName;
  link.click();
  // Адрес держит файл в памяти вкладки, пока его не отпустят.
  URL.revokeObjectURL(address);
}
