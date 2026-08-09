import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { pageNodeToDocxBuffer } from '@tessera/editor-ext';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { AttachmentRepo } from '@tessera/db/repos/attachment/attachment.repo';
import { User } from '@tessera/db/types/entity.types';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { StorageService } from '../../integrations/storage/storage.service';
import { jsonToNode } from '../../collaboration/collaboration.util';
import { getProsemirrorContent } from '../../common/helpers/prosemirror/utils';
import { getSafePageTitle } from '../../integrations/export/utils';
import { notFound } from '../../common/errors/app-error';

/**
 * Идентификатор вложения в ссылке вида /files/<id>/<имя> или /api/files/...
 *
 * Редактор хранит именно такие ссылки, прямых путей в хранилище в документе
 * нет. Разбор по регулярному выражению, а не по URL, потому что ссылка может
 * быть как относительной, так и абсолютной.
 */
const ATTACHMENT_URL_REGEX = /\/(?:api\/)?files\/([0-9a-fA-F-]{36})\/[^/?#]+/;

/** Заглушка вместо недоступной картинки, сериализатор такую пропускает. */
const EMPTY_IMAGE = new Uint8Array(0);

@Injectable()
export class DocxExportService {
  private readonly logger = new Logger(DocxExportService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Выгрузить страницу в Word.
   *
   * Доступ проверяется через PageAccessService, а не по членству в
   * пространстве: страница внутри доступного пространства может быть закрыта
   * отдельно.
   */
  async exportPage(
    pageId: string,
    user: User,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
    });
    if (!page || page.deletedAt) {
      throw notFound('error.common.page_not_found');
    }

    await this.pageAccessService.validateCanView(page, user);

    const prosemirrorJson = getProsemirrorContent(page.content);

    // Заголовок страницы хранится отдельно от содержимого, в документ Word
    // он должен попасть первым узлом, иначе файл начнется с текста без
    // названия.
    if (page.title) {
      prosemirrorJson.content.unshift({
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: page.title }],
      });
    }

    const doc = jsonToNode(prosemirrorJson);
    if (!doc) {
      throw notFound('error.docx_export.page_content_is_empty');
    }

    const buffer = await pageNodeToDocxBuffer(doc, (src: string) =>
      this.resolveImage(src, page.spaceId),
    );

    return {
      fileName: `${getSafePageTitle(page.title)}.docx`,
      buffer,
    };
  }

  /**
   * Содержимое картинки для сериализатора.
   *
   * Возвращает пустой буфер, если вложение не найдено, не принадлежит
   * пространству страницы или не читается. Пустой, а не null: сериализатор
   * определяет размеры по содержимому и молча пропускает картинку, размеры
   * которой не читаются, тогда как null уронил бы разбор. Одна битая картинка
   * не должна ронять выгрузку всего документа.
   *
   * Проверка пространства обязательна, иначе ссылка на чужое вложение,
   * вписанная в документ руками, вытащила бы его содержимое в файл.
   */
  private async resolveImage(
    src: string,
    spaceId: string,
  ): Promise<Uint8Array> {
    const match = ATTACHMENT_URL_REGEX.exec(src ?? '');
    if (!match) return EMPTY_IMAGE;

    try {
      const attachment = await this.attachmentRepo.findById(match[1]);
      if (!attachment || attachment.deletedAt) return EMPTY_IMAGE;
      if (attachment.spaceId !== spaceId) {
        this.logger.debug(
          `Вложение ${match[1]} не принадлежит пространству страницы, пропущено`,
        );
        return EMPTY_IMAGE;
      }
      return await this.storageService.read(attachment.filePath);
    } catch (err) {
      this.logger.debug(
        `Картинка ${src} не попала в документ: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return EMPTY_IMAGE;
    }
  }
}
