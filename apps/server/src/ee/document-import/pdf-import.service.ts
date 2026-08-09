import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { processPdf } from '@docmost/pdf-inspector';
import { markdownToHtml } from '@tessera/editor-ext';
import { badRequest } from '../../common/errors/app-error';

/**
 * Типы PDF, у которых нет текстового слоя.
 *
 * Сканы и страницы-картинки библиотека распознаёт сама и текста не отдаёт.
 * Извлекать из них текст можно только распознаванием, а его в развёртывании
 * нет, поэтому такой файл отклоняется с внятным сообщением, а не превращается
 * в пустую страницу.
 */
const TYPES_WITHOUT_TEXT = new Set(['Scanned', 'ImageBased']);

/**
 * Импорт PDF в страницу.
 *
 * Разбор идёт в три шага: pdf-inspector отдаёт markdown, `markdownToHtml`
 * превращает его в HTML, дальше работает существующий путь импорта HTML.
 * Тот же контракт, что у импорта Word: наружу отдаётся HTML.
 *
 * Что переносится, проверено измерением на реальных файлах:
 * заголовки с уровнями, абзацы, маркированные списки, кириллица.
 * Что теряется: начертание внутри строки (жирный, курсив), таблицы и
 * картинки. Библиотека не отдаёт ни таблицы, ни изображения даже там, где
 * они в документе есть, поэтому обещать их перенос нельзя.
 */
@Injectable()
export class PdfImportService {
  private readonly logger = new Logger(PdfImportService.name);

  constructor() {}

  /**
   * Превратить PDF в HTML.
   *
   * Параметры пространства и страницы не используются: переносить во
   * вложения нечего, картинки из PDF не извлекаются. Сигнатура сохранена
   * такой же, как у импорта Word, потому что её задаёт вызывающий код
   * в `ImportService.processPdf`.
   */
  async convertPdfToHtml(
    fileBuffer: Buffer,
    _workspaceId: string,
    _spaceId: string,
    _pageId: string,
    _userId: string,
  ): Promise<string> {
    if (!fileBuffer?.length) {
      throw badRequest('error.import.pdf_empty');
    }

    let result: ReturnType<typeof processPdf>;
    try {
      result = processPdf(fileBuffer);
    } catch (err) {
      this.logger.error(
        `Не удалось разобрать PDF: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw badRequest('error.import.pdf_unreadable');
    }

    const markdown = result?.markdown?.trim() ?? '';

    if (TYPES_WITHOUT_TEXT.has(result?.pdfType) || !markdown) {
      this.logger.debug(
        `PDF без текстового слоя: тип ${result?.pdfType}, страниц ${result?.pageCount}`,
      );
      throw badRequest('error.import.pdf_no_text_layer');
    }

    if (result.pagesNeedingOcr?.length) {
      // Часть страниц без текста это не отказ: остальные переносятся.
      this.logger.debug(
        `Страницы без текстового слоя пропущены: ${result.pagesNeedingOcr.join(', ')}`,
      );
    }

    return await markdownToHtml(markdown);
  }
}
