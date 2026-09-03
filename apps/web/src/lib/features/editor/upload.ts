/**
 * Загрузка файла в документ.
 *
 * Порядок обратный тому, что в v1: там сначала вставляется пустой узел-заглушка,
 * а после ответа сервера он подменяется настоящим. Здесь узел заводится уже
 * готовым. Причина в общем документе: заглушка — это правка, она уходит всем
 * соединённым, и второй человек видит пустую рамку, которая у него никогда не
 * заполнится, если у первого отказала загрузка. Ожидание ответа сервера видно
 * на самой кнопке, а документ до конца загрузки не трогается вовсе.
 */

import type { Editor } from '@tiptap/core';
import { uploadPageFile, type Attachment } from '$lib/features/page/services/attachments';

/** Виды вложений, у каждого свой узел документа. */
export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'attachment';

/** Что предлагать в окне выбора файла. Совпадает с v1. */
export const ACCEPT: Record<MediaKind, string> = {
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
  pdf: 'application/pdf',
  attachment: '*/*'
};

/**
 * Адрес вложения внутри документа.
 *
 * Без отметки времени, в отличие от `attachmentUrl`: та отметка нужна
 * диаграммам, которые перезаписывают вложение на месте. Обычное вложение не
 * меняется, а отметка в адресе попала бы в документ и осталась бы там навсегда.
 */
function fileUrl(attachment: Attachment): string {
  return `/api/files/${attachment.id}/${encodeURIComponent(attachment.fileName)}`;
}

/** Спросить файл у человека. Возвращает `null`, если окно закрыли. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    // Окно выбора не сообщает об отмене: событие `change` при отмене не
    // приходит вовсе. Обещание в этом случае остаётся неразрешённым, и это
    // допустимо — вызывающий просто не делает ничего.
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.click();
  });
}

/** Завести узел вложения по уже загруженному файлу. */
export function insertMedia(editor: Editor, kind: MediaKind, attachment: Attachment): void {
  const src = fileUrl(attachment);
  const size = attachment.fileSize ?? undefined;
  const chain = editor.chain().focus();

  if (kind === 'image') chain.setImage({ src, attachmentId: attachment.id, size }).run();
  else if (kind === 'video') chain.setVideo({ src, attachmentId: attachment.id, size }).run();
  else if (kind === 'audio') chain.setAudio({ src, attachmentId: attachment.id, size }).run();
  else if (kind === 'pdf')
    chain.setPdf({ src, name: attachment.fileName, attachmentId: attachment.id, size }).run();
  else
    chain
      .setAttachment({
        url: src,
        name: attachment.fileName,
        mime: attachment.mimeType ?? undefined,
        size,
        attachmentId: attachment.id
      })
      .run();
}

/** Загрузить файл и завести его узел. */
export async function uploadAndInsert(
  editor: Editor,
  pageId: string,
  kind: MediaKind,
  file: File
): Promise<void> {
  insertMedia(editor, kind, await uploadPageFile(file, pageId));
}

/**
 * Вид вложения по типу файла.
 *
 * Нужен вставке из буфера и переносу файла мышью: там вид не выбирают, его
 * определяют по самому файлу. Всё, что не картинка, не видео, не звук и не
 * PDF, становится вложением — показывать его внутри страницы нечем.
 */
export function kindOf(file: File): MediaKind {
  const mime = file.type;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'attachment';
}
