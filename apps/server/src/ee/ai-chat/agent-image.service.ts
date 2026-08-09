import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AttachmentRepo } from '@tessera/db/repos/attachment/attachment.repo';
import { StorageService } from '../../integrations/storage/storage.service';
import { getAttachmentFolderPath } from '../../core/attachment/attachment.utils';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { sanitizeFileName } from '../../common/helpers';

/**
 * Картинки, найденные агентом, переносятся во вложения страницы.
 *
 * Агент вставлял в страницу адрес найденного изображения как есть, поэтому
 * браузер читателя шел за картинкой на чужой сервер. Остальной продукт
 * работает в закрытом контуре, и одна такая ссылка это и обращение наружу с
 * каждого просмотра, и утечка факта просмотра, и мертвая картинка в тот день,
 * когда чужой сервер ее уберет.
 *
 * Способ тот же, что у импорта DOCX: файл кладется в хранилище и
 * записывается вложением страницы, а в содержимое идет внутренний адрес.
 * Скачивание делает сервер, один раз, а не каждый читатель при каждом
 * открытии.
 */

/** Расширение по типу содержимого. Неизвестный тип не переносится. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

/** Верхняя граница картинки: она читается в память целиком. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Сколько ждать чужой сервер: ответ агента не должен из-за него зависать. */
const TIMEOUT_MS = 8000;

/** Сколько картинок переносится за один ответ. */
const MAX_IMAGES = 12;

/** Разметка картинки в markdown: `![подпись](адрес)`. */
const IMAGE_MARKUP = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;

type Target = {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  userId: string;
};

@Injectable()
export class AgentImageService {
  private readonly logger = new Logger(AgentImageService.name);

  constructor(
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Заменить внешние адреса картинок на внутренние.
   *
   * Не перенесенная картинка убирается из разметки: оставить внешний адрес
   * значило бы сохранить ровно то, ради чего перенос и делается. Текст вокруг
   * остается нетронутым.
   */
  async localizeImages(markdown: string, target: Target): Promise<string> {
    if (!markdown || !markdown.includes('![')) return markdown;

    const matches = [...markdown.matchAll(IMAGE_MARKUP)].slice(0, MAX_IMAGES);
    if (matches.length === 0) return markdown;

    let result = markdown;

    for (const match of matches) {
      const [markup, alt, url] = match;
      const stored = await this.store(url, target);

      result = result.replace(markup, stored ? `![${alt}](${stored})` : '');
    }

    return result;
  }

  private async store(url: string, target: Target): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;

      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();

      const extension = IMAGE_EXTENSIONS[contentType];
      if (!extension) {
        this.logger.debug(`Картинка типа ${contentType} не перенесена`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
        this.logger.debug(`Картинка размером ${buffer.length} не перенесена`);
        return null;
      }

      const attachmentId = randomUUID();
      const fileName = `${sanitizeFileName('image')}-${attachmentId}${extension}`;
      const filePath = `${getAttachmentFolderPath(
        AttachmentType.File,
        target.workspaceId,
      )}/${attachmentId}/${fileName}`;

      await this.storageService.upload(filePath, buffer);

      await this.attachmentRepo.insertAttachment({
        id: attachmentId,
        type: AttachmentType.File,
        filePath,
        fileName,
        fileSize: buffer.length,
        mimeType: contentType,
        fileExt: extension,
        creatorId: target.userId,
        workspaceId: target.workspaceId,
        spaceId: target.spaceId,
        pageId: target.pageId,
      });

      // Тот же вид адреса, что ставит редактор при загрузке файла вручную.
      return `/api/files/${attachmentId}/${fileName}`;
    } catch (err) {
      this.logger.warn(
        `Картинка не перенесена: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
