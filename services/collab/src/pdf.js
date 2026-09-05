/**
 * Разбор PDF в HTML.
 *
 * Здесь, а не на стороне Python, потому что качество разбора — свойство
 * библиотеки, а не языка: `@docmost/pdf-inspector` отдаёт markdown с
 * заголовками и списками, тогда как `pypdf` отдаёт голый текст, и ввезённый
 * документ терял всю структуру. Пакет уже объявлен в файле блокировки
 * (`apps/server`), новой зависимости в развёртывании не появляется, а сервис
 * преобразования для того и существует — там уже живут HTML, Markdown и вывоз
 * DOCX.
 *
 * Что переносится, замерено в v1 на настоящих файлах: заголовки с уровнями,
 * абзацы, маркированные списки, кириллица. Что теряется: начертание внутри
 * строки, таблицы и картинки — библиотека их не отдаёт даже там, где они в
 * документе есть, поэтому обещать их перенос нельзя.
 */
import { createRequire } from 'node:module';

import { markdownToHtml } from './extensions.js';

const require = createRequire(import.meta.url);

/** Виды PDF, у которых текстового слоя нет вовсе. */
const WITHOUT_TEXT = new Set(['Scanned', 'ImageBased']);

/**
 * Причины отказа. Уходят кодом, а не текстом: перевод живёт на стороне,
 * которая говорит с человеком, и второй его набор здесь разошёлся бы с первым.
 */
export const PDF_EMPTY = 'pdf_empty';
export const PDF_UNREADABLE = 'pdf_unreadable';
export const PDF_NO_TEXT_LAYER = 'pdf_no_text_layer';

/**
 * Разобрать PDF.
 *
 * Библиотека грузится при первом обращении, а не при запуске: сервис поднимают
 * ради совместной правки, и разбор PDF в этом пути не участвует.
 */
export async function htmlFromPdf(base64, parser) {
  const bytes = Buffer.from(base64 || '', 'base64');
  if (!bytes.length) throw new Error(PDF_EMPTY);

  const processPdf = parser ?? require('@docmost/pdf-inspector').processPdf;

  let parsed;
  try {
    parsed = processPdf(bytes);
  } catch {
    throw new Error(PDF_UNREADABLE);
  }

  const markdown = (parsed?.markdown ?? '').trim();
  if (WITHOUT_TEXT.has(parsed?.pdfType) || !markdown) {
    // Скан без текстового слоя. Достать из него текст можно только
    // распознаванием, которого в развёртывании нет, и пустая страница вместо
    // документа выглядела бы успешным ввозом.
    throw new Error(PDF_NO_TEXT_LAYER);
  }

  return await markdownToHtml(markdown);
}
