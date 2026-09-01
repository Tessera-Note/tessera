import { apiBase } from '$lib/api/base';
import { ApiError } from '$lib/api/client';

/** Вложение так, как его отдаёт сервер. */
export type Attachment = {
  id: string;
  fileName: string;
  fileSize: number | null;
  mimeType: string | null;
  pageId: string | null;
  updatedAt: string | null;
};

/**
 * Загрузить файл страницы.
 *
 * Через `fetch`, а не через общий слой запросов: тело здесь многочастное, и
 * `post` отправляет только JSON.
 *
 * `replaces` перезаписывает уже существующее вложение, оставляя ему тот же
 * идентификатор. Нужен диаграммам: на вложение ссылается узел документа, и
 * новое вложение на каждое сохранение означало бы, что ссылка указывает на
 * прежний файл, а правка ушла в новый.
 */
export async function uploadPageFile(
  file: File,
  pageId: string,
  replaces?: string
): Promise<Attachment> {
  const body = new FormData();
  body.append('file', file);
  body.append('pageId', pageId);
  if (replaces) body.append('attachmentId', replaces);

  const response = await fetch(`${apiBase()}/api/files/upload`, {
    method: 'POST',
    credentials: 'include',
    body
  });

  if (!response.ok) {
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

  return (await response.json()) as Attachment;
}

/** Адрес файла вложения. Время правки обходит кеш браузера. */
export function attachmentUrl(attachment: Attachment): string {
  const stamp = attachment.updatedAt ? new Date(attachment.updatedAt).getTime() : Date.now();
  return `/api/files/${attachment.id}/${encodeURIComponent(attachment.fileName)}?t=${stamp}`;
}
