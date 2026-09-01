import { apiBase } from '$lib/api/base';
import { ApiError, post } from '$lib/api/client';

/** Страница в составе печатаемого документа. */
export type RenderPage = { pageId: string; title: string | null; content: unknown };

/**
 * Поставить страницу на печать.
 *
 * Заданием, а не ответом на запрос: ветвь из сотни страниц рисуется десятки
 * секунд, и держать запрос столько нельзя. Клиент опрашивает задание — тем же
 * способом, что и ввоз архива.
 */
export function exportPagePdf(
  values: { pageId: string; includeChildren?: boolean },
  fetcher?: typeof fetch
) {
  return post<{ fileTaskId: string }>('/api/pdf-export/page', values, { fetcher });
}

/**
 * Содержимое страниц для браузера печати.
 *
 * Вход не нужен: у безголового браузера его нет. Учётными данными служит токен,
 * выписанный на одно задание.
 */
export function renderData(
  token: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<{ pages: RenderPage[] }>('/api/pdf-export/render', { token }, { fetcher, headers });
}

/** Задание выгрузки в том виде, в каком его отдаёт сервер. */
export type FileTask = {
  id: string;
  type: string | null;
  source: string | null;
  status: string | null;
  fileName: string;
  errorMessage: string | null;
};

/** Задания рабочего пространства. Клиент опрашивает их, пока печать идёт. */
export function listFileTasks(fetcher?: typeof fetch) {
  return post<{ items: FileTask[] }>('/api/file-tasks/', {}, { fetcher });
}

/**
 * Забрать готовый документ.
 *
 * Через запрос, а не ссылкой: маршрут отвечает на `POST` и требует входа, а
 * обычная ссылка ушла бы без куки в части браузеров.
 */
export async function downloadPdf(fileTaskId: string, fileName: string): Promise<void> {
  const response = await fetch(`${apiBase()}/api/pdf-export/download`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileTaskId })
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
  URL.revokeObjectURL(address);
}
