import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { promises as fs } from 'fs';
import * as path from 'path';
import { v7 } from 'uuid';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { executeTx } from '@tessera/db/utils';
import { InsertablePage } from '@tessera/db/types/entity.types';
import { FileTask } from '@tessera/db/types/entity.types';
import { generateSlugId } from '../../common/helpers';
import { jsonToText } from '../../collaboration/collaboration.util';
import { getProsemirrorContent } from '../../common/helpers/prosemirror/utils';
import { ImportService } from '../../integrations/import/services/import.service';
import type { ImportAttachmentService } from '../../integrations/import/services/import-attachment.service';
import { buildAttachmentCandidates } from '../../integrations/import/utils/import.utils';
import { PageService } from '../../core/page/services/page.service';
import { BacklinkRepo } from '@tessera/db/repos/backlink/backlink.repo';
import { formatImportHtml } from '../../integrations/import/utils/import-formatter';
import {
  ConfluenceAttachment,
  ConfluenceTreeNode,
  extractConfluencePage,
  isConfluenceExport,
  parseConfluenceAttachments,
  parseConfluenceTree,
  titleFromFileName,
} from './confluence-archive';

/** Страница выгрузки, подготовленная к записи. */
type ConfluencePage = {
  id: string;
  slugId: string;
  href: string;
  title: string;
  parentPageId: string | null;
  position?: string;
  level: number;
};

@Injectable()
export class ConfluenceImportService {
  private readonly logger = new Logger(ConfluenceImportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly moduleRef: ModuleRef,
    private readonly pageService: PageService,
    private readonly backlinkRepo: BacklinkRepo,
  ) {}

  /** ImportService берется на месте вызова, см. комментарий в модуле. */
  private get importService(): ImportService {
    return this.moduleRef.get(ImportService, { strict: false });
  }

  /**
   * По той же причине, что и ImportService, но с отложенной загрузкой класса.
   *
   * Обычный импорт втянул бы `import-attachment.service` в граф модулей EE
   * даже как токен для ModuleRef, а вместе с ним ESM-only `p-limit`, который
   * не разбирает Jest. Тип берется через `import type` и в сборку не попадает.
   */
  private get importAttachmentService(): ImportAttachmentService {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ImportAttachmentService } = require(
      '../../integrations/import/services/import-attachment.service',
    );
    return this.moduleRef.get(ImportAttachmentService, { strict: false });
  }

  /**
   * Перенести выгрузку пространства Confluence.
   *
   * Первая часть работы: структура пространства и текст страниц. Вложения,
   * макросы Confluence и внутренние ссылки идут отдельными частями, их
   * ограничения описаны в сводке к задаче.
   *
   * Возвращает идентификатор корневой страницы, вызывающий код по нему
   * обновляет дерево в интерфейсе.
   */
  async processConfluenceImport(opts: {
    extractDir: string;
    fileTask: FileTask;
  }): Promise<string | null> {
    const { extractDir, fileTask } = opts;

    const indexPath = await this.findIndexFile(extractDir);
    if (!indexPath) {
      this.logger.warn('В архиве нет index.html, это не выгрузка Confluence');
      return null;
    }

    const indexHtml = await fs.readFile(indexPath, 'utf-8');
    if (!isConfluenceExport(indexHtml)) {
      this.logger.warn('index.html не похож на выгрузку Confluence');
      return null;
    }

    const tree = parseConfluenceTree(indexHtml);
    if (tree.length === 0) {
      this.logger.warn('В index.html не нашлось ни одной страницы');
      return null;
    }

    const archiveRoot = path.dirname(indexPath);
    // Корнем импорта считается папка с index.html, а не корень распаковки:
    // ссылки на вложения в выгрузке заданы относительно нее
    // (`attachments/65601/65602`). Собери кандидатов от корня распаковки,
    // и ключи получат лишний префикс папки архива, после чего пара draw.io
    // не найдет свой файл и молча потеряется.
    const attachmentCandidates = await buildAttachmentCandidates(archiveRoot);
    const pages = this.flattenTree(tree);
    await this.assignPositions(pages, fileTask.spaceId);

    const space = await this.db
      .selectFrom('spaces')
      .select(['slug'])
      .where('id', '=', fileTask.spaceId)
      .executeTakeFirst();

    // Ссылки между страницами разрешаются по имени файла: в выгрузке
    // страницы ссылаются друг на друга именно так.
    const filePathToPageMetaMap = new Map(
      pages.map((page) => [
        page.href,
        { id: page.id, title: page.title, slugId: page.slugId },
      ]),
    );

    const inserted: string[] = [];
    const backlinks: any[] = [];

    await executeTx(this.db, async (trx) => {
      // Порядок по уровням обязателен: родитель должен существовать
      // до вставки потомка.
      for (const page of [...pages].sort((a, b) => a.level - b.level)) {
        const { html, attachments } = await this.readPageHtml(
          archiveRoot,
          page,
        );

        // isConfluenceImport включает уже написанную обработку особенностей
        // выгрузки: пары draw.io, файлы без расширения, числовые имена.
        const withAttachments =
          await this.importAttachmentService.processAttachments({
            html,
            pageRelativePath: page.href,
            extractDir: archiveRoot,
            pageId: page.id,
            fileTask,
            attachmentCandidates,
            pageAttachments: attachments,
            isConfluenceImport: true,
          });

        const formatted = await formatImportHtml({
          html: withAttachments,
          currentFilePath: page.href,
          filePathToPageMetaMap,
          creatorId: fileTask.creatorId,
          sourcePageId: page.id,
          workspaceId: fileTask.workspaceId,
          spaceSlug: space?.slug,
        });

        const pmState = getProsemirrorContent(
          await this.importService.processHTML(formatted.html),
        );
        const { prosemirrorJson } =
          this.importService.extractTitleAndRemoveHeading(pmState);

        const insertablePage: InsertablePage = {
          id: page.id,
          slugId: page.slugId,
          // Заголовок берется из выгрузки, а не из первого узла содержимого:
          // в Confluence он хранится отдельно от тела страницы.
          title: page.title,
          content: prosemirrorJson,
          textContent: jsonToText(prosemirrorJson),
          ydoc: await this.importService.createYdoc(prosemirrorJson),
          position: page.position!,
          spaceId: fileTask.spaceId,
          workspaceId: fileTask.workspaceId,
          creatorId: fileTask.creatorId,
          lastUpdatedById: fileTask.creatorId,
          parentPageId: page.parentPageId,
        };

        await trx.insertInto('pages').values(insertablePage).execute();
        inserted.push(page.id);
        backlinks.push(...formatted.backlinks);
      }

      // Обратные ссылки пишутся после всех страниц: обе стороны связи должны
      // существовать, иначе внешний ключ отвергнет запись. Ссылки на страницы,
      // которых в выгрузке не оказалось, отбрасываются.
      const validIds = new Set(inserted);
      const usable = backlinks.filter(
        (link) =>
          validIds.has(link.sourcePageId) && validIds.has(link.targetPageId),
      );

      for (const link of usable) {
        await this.backlinkRepo.insertBacklink(link, trx);
      }

      if (usable.length > 0) {
        this.logger.log(`Перенесено связей между страницами: ${usable.length}`);
      }
    });

    this.logger.log(`Перенесено страниц из Confluence: ${inserted.length}`);
    return inserted[0] ?? null;
  }

  /** index.html в корне архива или в единственной вложенной папке. */
  private async findIndexFile(extractDir: string): Promise<string | null> {
    const direct = path.join(extractDir, 'index.html');
    try {
      await fs.access(direct);
      return direct;
    } catch {
      // Архив часто распаковывается в одну папку с именем пространства.
    }

    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(extractDir, entry.name, 'index.html');
      try {
        await fs.access(nested);
        return nested;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Содержимое страницы.
   *
   * Отсутствующий файл не отменяет перенос: в index.html встречаются ссылки
   * на страницы, которых в архиве нет, и терять из-за них всё пространство
   * нельзя. Такая страница создается пустой.
   */
  private async readPageHtml(
    archiveRoot: string,
    page: ConfluencePage,
  ): Promise<{ html: string; attachments: ConfluenceAttachment[] }> {
    try {
      const raw = await fs.readFile(path.join(archiveRoot, page.href), 'utf-8');
      // Вложения разбираются из полного html: extractConfluencePage вырезает
      // раздел, в котором лежит их список.
      return {
        html: extractConfluencePage(raw).html,
        attachments: parseConfluenceAttachments(raw),
      };
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      this.logger.debug(`Файл страницы не найден в архиве: ${page.href}`);
      return { html: '', attachments: [] };
    }
  }

  /** Дерево в плоский список с уровнями и связями родитель-потомок. */
  private flattenTree(tree: ConfluenceTreeNode[]): ConfluencePage[] {
    const pages: ConfluencePage[] = [];

    const walk = (
      nodes: ConfluenceTreeNode[],
      parentPageId: string | null,
      level: number,
    ) => {
      for (const node of nodes) {
        const page: ConfluencePage = {
          id: v7(),
          slugId: generateSlugId(),
          href: node.href,
          title: node.title || titleFromFileName(node.href),
          parentPageId,
          level,
        };
        pages.push(page);
        walk(node.children, page.id, level + 1);
      }
    };

    walk(tree, null, 0);
    return pages;
  }

  /**
   * Ключи позиций.
   *
   * Корневые страницы встают после существующих в пространстве, потомки
   * нумеруются внутри своего родителя. Порядок братьев берется из выгрузки
   * и не пересортировывается по алфавиту: в Confluence он осмысленный.
   */
  private async assignPositions(
    pages: ConfluencePage[],
    spaceId: string,
  ): Promise<void> {
    const byParent = new Map<string | null, ConfluencePage[]>();
    for (const page of pages) {
      const group = byParent.get(page.parentPageId) ?? [];
      group.push(page);
      byParent.set(page.parentPageId, group);
    }

    const roots = byParent.get(null) ?? [];
    if (roots.length) {
      const nextPosition = await this.pageService.nextPagePosition(spaceId);
      let prev: string | null = null;
      roots.forEach((page, index) => {
        page.position =
          index === 0 ? nextPosition : generateJitteredKeyBetween(prev, null);
        prev = page.position;
      });
    }

    byParent.forEach((siblings, parentId) => {
      if (parentId === null) return;
      let prev: string | null = null;
      for (const page of siblings) {
        page.position = generateJitteredKeyBetween(prev, null);
        prev = page.position;
      }
    });
  }
}
