import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as mammoth from 'mammoth';
import { randomUUID } from 'crypto';
import { AttachmentRepo } from '@tessera/db/repos/attachment/attachment.repo';
import { StorageService } from '../../integrations/storage/storage.service';
import { getAttachmentFolderPath } from '../../core/attachment/attachment.utils';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { sanitizeFileName } from '../../common/helpers';
import { badRequest } from '../../common/errors/app-error';

/**
 * Расширение по типу картинки, вшитой в документ.
 *
 * Word хранит картинки без имён, только с типом содержимого, поэтому имя
 * файла собирается здесь. Неизвестный тип отбрасывается: класть в хранилище
 * файл с расширением, которого не понимает ни редактор, ни браузер, смысла нет.
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg',
};

/**
 * Верхняя граница картинки, переносимой в хранилище.
 *
 * Документ читается в память целиком, и без границы один документ с обоями
 * на сто мегабайт занял бы память на всё время разбора.
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Импорт документа Word в страницу.
 *
 * Разбор идёт в два шага: mammoth превращает DOCX в HTML, а дальше работает
 * существующий путь импорта HTML (`ImportService.processHTML`), уже покрытый
 * нормализацией и преобразованием в структуру редактора. Своего разбора
 * OOXML здесь нет и не нужно.
 */
@Injectable()
export class DocxImportService {
  private readonly logger = new Logger(DocxImportService.name);

  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Превратить документ Word в HTML.
   *
   * Картинки из документа переносятся во вложения страницы, а не остаются
   * base64 внутри HTML: иначе содержимое страницы распухало бы на размер всех
   * изображений, а редактор не смог бы показать их как вложения.
   */
  async convertDocxToHtml(
    fileBuffer: Buffer,
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
  ): Promise<string> {
    if (!fileBuffer?.length) {
      throw badRequest('error.import.docx_empty');
    }

    let result: { value: string; messages: { message: string }[] };
    try {
      result = await mammoth.convertToHtml(
        { buffer: fileBuffer },
        {
          convertImage: mammoth.images.imgElement(async (image) =>
            this.storeImage(image, workspaceId, spaceId, pageId, userId),
          ),
        },
      );
    } catch (err) {
      this.logger.error(
        `Не удалось разобрать документ Word: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw badRequest('error.import.docx_unreadable');
    }

    // Предупреждения разбора не ошибка: mammoth сообщает о стилях, которым
    // нет соответствия в HTML, и документ при этом переносится.
    if (result.messages?.length) {
      this.logger.debug(
        `Замечания при разборе документа: ${result.messages
          .map((message) => message.message)
          .join('; ')}`,
      );
    }

    return result.value ?? '';
  }

  /**
   * Сохранить картинку из документа как вложение страницы.
   *
   * При любом сбое возвращается пустой src: одна непереносимая картинка не
   * должна отменять импорт всего документа, а пустая ссылка отбрасывается
   * нормализацией HTML дальше по пути.
   */
  private async storeImage(
    image: {
      contentType?: string;
      read: (encoding?: string) => Promise<Buffer>;
    },
    workspaceId: string,
    spaceId: string,
    pageId: string,
    userId: string,
  ): Promise<{ src: string }> {
    const extension = IMAGE_EXTENSIONS[(image.contentType ?? '').toLowerCase()];
    if (!extension) {
      this.logger.debug(
        `Картинка типа ${image.contentType} пропущена: тип не поддерживается`,
      );
      return { src: '' };
    }

    try {
      const buffer = await image.read();
      if (!buffer?.length || buffer.length > MAX_IMAGE_BYTES) {
        this.logger.debug(
          `Картинка пропущена: размер ${buffer?.length ?? 0} вне допустимого`,
        );
        return { src: '' };
      }

      const attachmentId = randomUUID();
      const fileName = `${sanitizeFileName('image')}-${attachmentId}${extension}`;
      const storageFilePath = `${getAttachmentFolderPath(
        AttachmentType.File,
        workspaceId,
      )}/${attachmentId}/${fileName}`;

      await this.storageService.upload(storageFilePath, buffer);

      await this.attachmentRepo.insertAttachment({
        id: attachmentId,
        type: AttachmentType.File,
        filePath: storageFilePath,
        fileName,
        fileSize: buffer.length,
        mimeType: image.contentType,
        fileExt: extension,
        creatorId: userId,
        workspaceId,
        spaceId,
        pageId,
      });

      // Тот же вид ссылки, что ставит редактор при загрузке файла вручную.
      return { src: `/api/files/${attachmentId}/${fileName}` };
    } catch (err) {
      this.logger.warn(
        `Картинка из документа не перенесена: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { src: '' };
    }
  }
}
