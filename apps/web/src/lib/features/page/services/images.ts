/**
 * Значки картинкой: аватар человека, логотип рабочего пространства, значок
 * пространства.
 *
 * Отдельно от вложений страницы: у тех другой маршрут, другие права и другой
 * предел размера. Общего только многочастное тело, из-за которого запрос идёт
 * мимо общего слоя — тот отправляет только JSON.
 *
 * Пути начинаются с `/api/attachments`, а не с `/api/files`. Различие
 * незаметное и стоило отдельной проверки: оба контроллера живут в одном файле
 * (`apps/api/tessera_api/api/attachments.py`), вложения страницы — под
 * `/api/files`, значки — под `/api/attachments`.
 *
 * В базу пишется имя файла, а не адрес: так в v1, и адрес собирает клиент.
 */

import { apiBase } from '$lib/api/base';
import { ApiError } from '$lib/api/client';

/** Виды картинок. Значения понимает сервер. */
export type ImageKind = 'avatar' | 'workspace-icon' | 'space-icon';

/** Что принимает сервер. Совпадает с `IMAGE_EXTENSIONS` на его стороне. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';

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

/** Загрузить значок. Возвращает имя файла, которое сервер записал в колонку. */
export async function uploadImage(
  kind: ImageKind,
  file: File,
  spaceId?: string
): Promise<{ fileName: string }> {
  const body = new FormData();
  body.append('file', file);
  body.append('type', kind);
  if (spaceId) body.append('spaceId', spaceId);

  const response = await fetch(`${apiBase()}/api/attachments/upload-image`, {
    method: 'POST',
    credentials: 'include',
    body
  });
  if (!response.ok) await fail(response);
  return (await response.json()) as { fileName: string };
}

/** Снять значок. Файл из хранилища сервер убирает сам. */
export async function removeIcon(kind: ImageKind, spaceId?: string): Promise<void> {
  const response = await fetch(`${apiBase()}/api/attachments/remove-icon`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: kind, spaceId })
  });
  if (!response.ok) await fail(response);
}

/**
 * Адрес значка.
 *
 * Значение, начинающееся с `http`, отдаётся как есть: так хранится значок,
 * пришедший от внешнего провайдера входа, и он лежит не в нашем хранилище.
 */
export function imageUrl(kind: ImageKind, fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  if (fileName.startsWith('http')) return fileName;
  return `/api/attachments/img/${kind}/${encodeURIComponent(fileName)}`;
}
