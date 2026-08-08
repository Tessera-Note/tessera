import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { StorageService } from '../../integrations/storage/storage.service';

/**
 * Состояния индексации вложения, те же значения, что и в колонке
 * attachments.index_status.
 */
export const IndexStatus = {
  NotProcessed: 'not_processed',
  Extracted: 'extracted',
  Unsupported: 'unsupported',
} as const;

/**
 * Верхняя граница читаемого куска файла.
 *
 * Файл читается в память целиком, поэтому граница нужна: текстовый лог на
 * сотни мегабайт иначе уронил бы процесс. Превышение не делает тип
 * неподдерживаемым, текст просто обрезается.
 */
const MAX_INDEX_BYTES = 2 * 1024 * 1024;

/**
 * Верхняя граница сохраняемого текста. Совпадает с границей, до которой
 * триггер строит tsvector: хранить больше бессмысленно, в вектор оно не попадет.
 */
const MAX_TEXT_CHARS = 1_000_000;

/** Расширения, разбираемые как обычный текст. */
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.text',
  '.log',
  '.md',
  '.markdown',
  '.mdown',
  '.json',
  '.csv',
  '.tsv',
  '.yml',
  '.yaml',
]);

/** MIME-типы сверх префикса text/, разбираемые как текст. */
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/x-ndjson',
  'application/yaml',
  'application/x-yaml',
]);

/**
 * Извлечение текста из вложений для полнотекстового поиска.
 *
 * Согласованный объем: text, markdown и json. PDF, DOCX и прочие форматы
 * требуют внешних разборщиков и отмечаются как неподдерживаемые, чтобы
 * повторный проход их не перебирал.
 */
@Injectable()
export class AttachmentEeService {
  private readonly logger = new Logger(AttachmentEeService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Поддерживается ли тип разбором.
   *
   * MIME-тип главнее расширения: имя файла задает загружающий, а тип
   * определяется при приеме. Расширение это запасной признак для случаев,
   * когда MIME пришел как application/octet-stream.
   */
  isSupported(mimeType: string | null, fileExt: string | null): boolean {
    const mime = (mimeType ?? '').toLowerCase().split(';')[0].trim();
    if (mime.startsWith('text/')) return true;
    if (TEXT_MIME_TYPES.has(mime)) return true;

    const ext = (fileExt ?? '').toLowerCase();
    return TEXT_EXTENSIONS.has(ext.startsWith('.') ? ext : `.${ext}`);
  }

  /**
   * Разобрать одно вложение.
   *
   * Неподдерживаемый тип не ошибка: запись получает отметку unsupported и
   * больше не перебирается. Сбой чтения из хранилища оставляет запись
   * в прежнем состоянии, чтобы повтор задачи мог сработать.
   */
  async indexAttachment(attachmentId: string): Promise<void> {
    const attachment = await this.db
      .selectFrom('attachments')
      .select(['id', 'filePath', 'mimeType', 'fileExt', 'fileSize'])
      .where('id', '=', attachmentId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!attachment) {
      this.logger.debug(`Вложение ${attachmentId} не найдено или удалено`);
      return;
    }

    if (!this.isSupported(attachment.mimeType, attachment.fileExt)) {
      await this.markStatus(attachmentId, IndexStatus.Unsupported);
      return;
    }

    let text: string;
    try {
      text = await this.readText(attachment.filePath, attachment.fileSize);
    } catch (err) {
      // Состояние не меняется: повтор задачи должен иметь шанс.
      this.logger.warn(
        `Не удалось прочитать вложение ${attachmentId} для индексации: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    await this.db
      .updateTable('attachments')
      .set({
        textContent: text,
        indexStatus: IndexStatus.Extracted,
        updatedAt: new Date(),
      } as any)
      .where('id', '=', attachmentId)
      .execute();
  }

  /**
   * Разобрать все необработанные вложения рабочего пространства.
   *
   * Берутся только записи в not_processed: extracted уже разобраны,
   * unsupported разбору не подлежат. Обход идет по одной записи, чтобы
   * сбой на одном файле не отменял остальные.
   */
  async indexAttachments(workspaceId: string): Promise<number> {
    const pending = await this.db
      .selectFrom('attachments')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where('indexStatus', '=', IndexStatus.NotProcessed)
      .execute();

    let processed = 0;
    for (const row of pending) {
      try {
        await this.indexAttachment(row.id);
        processed += 1;
      } catch (err) {
        this.logger.error(
          `Индексация вложения ${row.id} не удалась`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    if (processed > 0) {
      this.logger.log(
        `Проиндексировано вложений в пространстве ${workspaceId}: ${processed}`,
      );
    }
    return processed;
  }

  /** Прочитать файл текстом, не выходя за границу по памяти. */
  private async readText(
    filePath: string,
    // bigint приходит из драйвера строкой, поэтому тип шире числового.
    fileSize: number | bigint | string | null,
  ): Promise<string> {
    const parsed = fileSize == null ? NaN : Number(fileSize);
    const size = Number.isFinite(parsed) ? parsed : null;

    let buffer: Buffer;
    if (size !== null && size > MAX_INDEX_BYTES) {
      const stream = await this.storageService.readRangeStream(filePath, {
        start: 0,
        end: MAX_INDEX_BYTES - 1,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    } else {
      buffer = await this.storageService.read(filePath);
      if (buffer.length > MAX_INDEX_BYTES) {
        buffer = buffer.subarray(0, MAX_INDEX_BYTES);
      }
    }

    // Обрезка по границе байт может разрубить многобайтовый символ,
    // decode с fatal=false заменит его на U+FFFD вместо исключения.
    return buffer.toString('utf8').slice(0, MAX_TEXT_CHARS);
  }

  private async markStatus(
    attachmentId: string,
    status: string,
  ): Promise<void> {
    await this.db
      .updateTable('attachments')
      .set({ indexStatus: status, updatedAt: new Date() } as any)
      .where('id', '=', attachmentId)
      .execute();
  }
}
