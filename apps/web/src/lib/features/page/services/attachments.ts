import { apiBase } from '$lib/api/base';
import { ApiError, post } from '$lib/api/client';

/** Вложение так, как его отдаёт сервер. */
export type Attachment = {
  id: string;
  fileName: string;
  fileSize: number | null;
  mimeType: string | null;
  pageId: string | null;
  updatedAt: string | null;
  /**
   * Попадёт ли содержимое файла в поиск.
   *
   * Правило разбора живёт на сервере: извлечение текста берёт обычный текст,
   * Markdown, JSON, PDF и DOCX, а картинка, архив и PDF из сканов не попадут в
   * поиск никогда. Повторять этот список на клиенте значило бы завести второе
   * правило, которое разойдётся с первым.
   */
  indexStatus?: string;
};

/** Что известно о вложении. Нужен карточке: размер и попадание в поиск. */
export function attachmentInfo(attachmentId: string, fetcher?: typeof fetch) {
  return post<Attachment>('/api/files/info', { attachmentId }, { fetcher });
}

/**
 * Размер файла словами.
 *
 * Считается от килобайта, а не от байта: вложение меньше килобайта в вики не
 * встречается, а «0 B» рядом с именем читается как пустой файл. Правило то же,
 * что в v1, чтобы одна и та же страница показывала один и тот же размер.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0.0 KB';

  const step = 1024;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  const kilobytes = bytes / step;
  const index = Math.min(
    Math.max(Math.floor(Math.log(kilobytes) / Math.log(step)), 0),
    units.length - 1
  );
  const size = kilobytes / step ** index;

  return `${size.toFixed(index === 0 ? 1 : 0)} ${units[index]}`;
}

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
