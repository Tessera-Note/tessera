import { processPdf } from '@docmost/pdf-inspector';
import * as mammoth from 'mammoth';

/**
 * Текст из PDF и DOCX для полнотекстового поиска.
 *
 * Те же библиотеки, что уже стоят ради импорта документов, поэтому новой
 * зависимости не заводится. Импорт из них строит содержимое страницы, здесь
 * нужен только текст, поэтому разметка снимается.
 *
 * Пустой ответ означает, что искать в файле нечего: у PDF из сканов нет
 * текстового слоя, а разборщик может не справиться с битым файлом. Это не
 * ошибка, и вызывающий отмечает такой файл один раз, а не перебирает заново.
 */

/** Разметка HTML снимается грубо: для поиска нужны слова, не структура. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Разметка markdown снимается так же: остаются слова. */
function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[>#\-*+\s]+/gm, ' ')
    .replace(/[*_`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function pdfText(buffer: Buffer): string {
  try {
    const result: any = processPdf(buffer);
    return stripMarkdown(result?.markdown ?? '');
  } catch {
    // Битый или зашифрованный файл: искать в нем нечего, и падать на этом
    // нельзя, иначе один файл останавливает обход всего пространства.
    return '';
  }
}

export async function docxText(buffer: Buffer): Promise<string> {
  try {
    // Картинки не переносятся: в поиске они не участвуют, а перенос завел бы
    // сюда хранилище и права, которых у извлечения текста нет.
    const result = await mammoth.convertToHtml({ buffer });
    return stripHtml(result?.value ?? '');
  } catch {
    return '';
  }
}
