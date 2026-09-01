import { apiBase } from '$lib/api/base';
import { ApiError, post } from '$lib/api/client';

export type BaseProperty = {
  id: string;
  name: string;
  type: string;
  position: string;
  typeOptions: Record<string, unknown> | null;
  isPrimary: boolean;
};

export type BaseView = {
  id: string;
  name: string;
  type: string;
  position: string;
  config: Record<string, unknown>;
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
 * Перечислены не все двадцать: заводить руками имеет смысл те, у которых
 * значение вводит человек. Вычисляемые (`createdAt`, `lastEditedBy`, `formula`)
 * заводятся вместе с настройками, которых у этого экрана пока нет.
 */
export const PROPERTY_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'longText', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' }
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

export function renameBase(baseId: string, name: string, fetcher?: typeof fetch) {
  return post<BaseInfo>('/api/bases/update', { baseId, name }, { fetcher });
}

export function createProperty(
  values: { baseId: string; name: string; type: string },
  fetcher?: typeof fetch
) {
  return post<BaseProperty>('/api/bases/properties/create', values, { fetcher });
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

export function deleteRow(baseId: string, rowId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/bases/rows/delete', { baseId, rowId }, { fetcher });
}

export function createView(baseId: string, name: string, fetcher?: typeof fetch) {
  return post<BaseView>('/api/bases/views/create', { baseId, name, type: 'table' }, { fetcher });
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
