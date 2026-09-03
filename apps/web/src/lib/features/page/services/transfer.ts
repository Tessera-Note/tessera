/**
 * Вывоз и ввоз страниц.
 *
 * Мимо общего слоя запросов, и по двум разным причинам. Вывоз отвечает файлом,
 * а не JSON: его надо отдать браузеру на сохранение. Ввоз шлёт многочастное
 * тело: `post` умеет только JSON.
 */

import { apiBase } from '$lib/api/base';
import { ApiError } from '$lib/api/client';
import { post } from '$lib/api/client';
import { fileNameOf } from './file-name';

/** Виды выгрузки. Значения понимает сервер, подписи видит человек. */
export const EXPORT_FORMATS = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'html', label: 'HTML' }
] as const;

/** Что принимает ввоз одного файла. Совпадает с `SINGLE_FILE_EXTENSIONS`. */
export const IMPORT_ACCEPT = '.md,.markdown,.html,.htm,.docx,.pdf';

/** Что принимает ввоз архива. */
export const IMPORT_ZIP_ACCEPT = '.zip';

/**
 * Откуда выгрузка.
 *
 * Три вида. Своя выгрузка задаёт дерево каталогами; Notion делает так же, но
 * приписывает к каждому имени длинный идентификатор; Confluence кладёт
 * страницы плоско, а иерархию пишет в `index.html`. Разбор всех трёх живёт на
 * сервере (`services/import_archives.py`).
 */
export const IMPORT_SOURCES = [
  { value: 'generic', label: 'Tessera export' },
  { value: 'notion', label: 'Notion export' },
  { value: 'confluence', label: 'Confluence export' }
] as const;

async function fail(response: Response): Promise<never> {
  const text = await response.text();
  let code = 'error.common.unknown';
  let message = '';
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string };
    code = parsed.code ?? code;
    message = parsed.message ?? '';
  } catch {
    // Тело не разобралось: отвечает не наш сервер, а что-то на его месте.
  }
  throw new ApiError(response.status, code, message, {});
}

/** Отдать полученный файл браузеру на сохранение. */
async function save(response: Response, fallback: string): Promise<void> {
  const name = fileNameOf(response.headers.get('content-disposition'), fallback);
  const blob = await response.blob();
  const address = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = address;
  link.download = name;
  link.click();
  // Адрес держит файл в памяти вкладки, пока его не отпустят.
  URL.revokeObjectURL(address);
}

async function download(path: string, body: unknown, fallback: string): Promise<void> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) await fail(response);
  await save(response, fallback);
}

/**
 * Выгрузить страницу.
 *
 * С потомками и вложениями выгрузка приходит архивом, без них — одним файлом:
 * решает это сервер, здесь только просьба.
 */
export function exportPage(values: {
  pageId: string;
  format: string;
  includeChildren?: boolean;
  includeAttachments?: boolean;
  fallbackName: string;
}): Promise<void> {
  return download(
    '/api/pages/export',
    {
      pageId: values.pageId,
      format: values.format,
      includeChildren: values.includeChildren ?? false,
      includeAttachments: values.includeAttachments ?? false
    },
    values.fallbackName
  );
}

/** Выгрузить страницу документом Word. */
export function exportDocx(pageId: string, fallbackName: string): Promise<void> {
  return download('/api/docx-export', { pageId }, fallbackName);
}

/** Выгрузить пространство целиком. Всегда архивом. */
export function exportSpace(values: {
  spaceId: string;
  format: string;
  includeAttachments?: boolean;
  fallbackName: string;
}): Promise<void> {
  return download(
    '/api/spaces/export',
    {
      spaceId: values.spaceId,
      format: values.format,
      includeAttachments: values.includeAttachments ?? false
    },
    values.fallbackName
  );
}

export type ImportedPage = {
  id: string;
  slugId: string;
  title: string | null;
  spaceId: string;
  parentPageId: string | null;
};

/** Ввезти один файл. Страница появляется сразу, ответ несёт её адрес. */
export async function importFile(values: {
  file: File;
  spaceId: string;
  parentPageId?: string;
}): Promise<ImportedPage> {
  const body = new FormData();
  body.append('file', values.file);
  body.append('spaceId', values.spaceId);
  if (values.parentPageId) body.append('parentPageId', values.parentPageId);

  const response = await fetch(`${apiBase()}/api/pages/import`, {
    method: 'POST',
    credentials: 'include',
    body
  });
  if (!response.ok) await fail(response);
  return (await response.json()) as ImportedPage;
}

export type FileTask = {
  id: string;
  type: string;
  source: string | null;
  status: string;
  fileName: string | null;
  fileSize: number | null;
  errorMessage: string | null;
  spaceId: string | null;
  pageId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/**
 * Ввезти архив.
 *
 * Ответ приходит заданием, а не страницами: архив разбирается в очереди, и
 * держать запрос всё это время нельзя. Ход виден в перечне заданий.
 */
export async function importArchive(values: {
  file: File;
  spaceId: string;
  source: string;
}): Promise<FileTask> {
  const body = new FormData();
  body.append('file', values.file);
  body.append('spaceId', values.spaceId);
  body.append('source', values.source);

  const response = await fetch(`${apiBase()}/api/pages/import-zip`, {
    method: 'POST',
    credentials: 'include',
    body
  });
  if (!response.ok) await fail(response);
  return (await response.json()) as FileTask;
}

/** Задания ввоза и вывоза. Видны только задания своих пространств. */
export function listImportTasks(
  cursor?: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<{
    items: FileTask[];
    meta: { limit: number; hasNextPage: boolean; nextCursor: string | null };
  }>('/api/file-tasks', { cursor }, { fetcher, headers });
}

export function importTaskInfo(fileTaskId: string, fetcher?: typeof fetch) {
  return post<FileTask>('/api/file-tasks/info', { fileTaskId }, { fetcher });
}
