import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Interval } from '@nestjs/schedule';
import { v7 as uuid7 } from 'uuid';
import {
  QueueJob,
  QueueName,
} from '../../integrations/queue/constants/queue.constants';
import {
  FileTaskStatus,
  FileTaskType,
  getFileTaskFolderPath,
} from '../../integrations/import/utils/file.utils';
import { StorageService } from '../../integrations/storage/storage.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { TokenService } from '../../core/auth/services/token.service';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { Page, User, Workspace } from '@tessera/db/types/entity.types';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { sanitizeFileName } from '../../common/helpers/utils';
import {
  badRequest,
  notFound,
  unauthorized,
} from '../../common/errors/app-error';

/** Page numbers only; Gotenberg requires a full document for header/footer. */
const FOOTER_HTML = `<!doctype html>
<html>
  <head>
    <style>
      body { margin: 0; font-family: sans-serif; }
      .footer { width: 100%; font-size: 9px; color: #888; text-align: right; padding: 0 14mm; }
    </style>
  </head>
  <body>
    <div class="footer"><span class="pageNumber"></span> / <span class="totalPages"></span></div>
  </body>
</html>`;

/** Pages pulled into one document when subpages are included. */
const MAX_PAGES_PER_EXPORT = 100;
/** How long a generated PDF is kept before the cleanup job removes it. */
const RETENTION_HOURS = 24;

export type PdfRenderPage = {
  pageId: string;
  title: string;
  content: unknown;
};

type ExportMetadata = { includeChildren?: boolean; pageIds?: string[] };

function parseMetadata(value: unknown): ExportMetadata {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ExportMetadata;
    } catch {
      return {};
    }
  }
  return value as ExportMetadata;
}

@Injectable()
export class PdfExportService {
  private readonly logger = new Logger(PdfExportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.FILE_TASK_QUEUE)
    private readonly fileTaskQueue: Queue,
    private readonly storageService: StorageService,
    private readonly environmentService: EnvironmentService,
    private readonly tokenService: TokenService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
  ) {}

  /* ------------------------------------------------------------ enqueueing */

  /**
   * Rendering runs a headless browser, which is far too slow to hold an HTTP
   * request open, so the export becomes a file task the client polls — the same
   * shape imports already use.
   */
  async createExportTask(opts: {
    pageId: string;
    includeChildren: boolean;
    user: User;
    workspace: Workspace;
  }): Promise<{ fileTaskId: string }> {
    const { pageId, includeChildren, user, workspace } = opts;

    const page = await this.pageRepo.findById(pageId);
    if (!page || page.deletedAt || page.workspaceId !== workspace.id) {
      throw notFound('error.common.page_not_found');
    }

    // Viewing is enough to export: the PDF contains nothing the user cannot
    // already read on screen.
    await this.pageAccessService.validateCanView(page, user);

    // Which pages go in the document is decided here, while the requesting user
    // is still in context. The renderer runs later with only a token, so it must
    // not be the thing deciding what may be read — a restricted subpage would
    // otherwise be printed for someone who cannot open it.
    const pageIds = includeChildren
      ? await this.collectViewablePageIds(page, user)
      : [page.id];

    const fileTaskId = uuid7();
    const title = page.title || 'untitled';
    // Two spellings on purpose: the download keeps the readable title, while the
    // storage key avoids spaces.
    const fileName = `${sanitizeFileName(title, { preserveSpaces: true })}.pdf`;
    const storageName = `${sanitizeFileName(title)}.pdf`;

    await this.db
      .insertInto('fileTasks')
      .values({
        id: fileTaskId,
        type: FileTaskType.Export,
        source: 'pdf',
        status: FileTaskStatus.Processing,
        fileName,
        filePath: `${getFileTaskFolderPath(FileTaskType.Export, workspace.id)}/${fileTaskId}/${storageName}`,
        fileExt: 'pdf',
        creatorId: user.id,
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId: workspace.id,
        // Pass the object, not JSON.stringify of it: postgres-js serializes a
        // string parameter into the jsonb column as a JSON *string*, so reads
        // come back as text. A ::jsonb cast does not help — the value is
        // already a JSON string by then.
        metadata: { includeChildren, pageIds } as any,
      })
      .execute();

    await this.fileTaskQueue.add(QueueJob.PDF_EXPORT_TASK, { fileTaskId });

    return { fileTaskId };
  }

  /* ------------------------------------------------------------- rendering */

  /**
   * Serves the page content to the headless browser. The browser is not logged
   * in, so it authenticates with the short-lived render token minted for this
   * export instead of a session.
   */
  async getRenderData(token: string): Promise<{ pages: PdfRenderPage[] }> {
    // verifyJwt lets the underlying jwt error escape, which would surface as a
    // 500 on what is really a rejected credential.
    let payload: { workspaceId: string; fileTaskId: string };
    try {
      payload = await this.tokenService.verifyJwt(token, JwtType.PDF_RENDER);
    } catch {
      throw unauthorized('error.pdf_export.invalid_or_expired_render_token');
    }

    const fileTask = await this.db
      .selectFrom('fileTasks')
      .selectAll()
      .where('id', '=', payload.fileTaskId)
      .where('workspaceId', '=', payload.workspaceId)
      .executeTakeFirst();

    if (!fileTask) {
      throw notFound('error.pdf_export.export_not_found');
    }

    // Tolerate both shapes: rows written before the jsonb cast was fixed hold a
    // JSON string rather than an object.
    const metadata = parseMetadata(fileTask.metadata);
    const pageIds = metadata.pageIds ?? [];

    if (pageIds.length === 0) {
      throw notFound('error.pdf_export.export_has_no_pages');
    }

    const rows = await this.db
      .selectFrom('pages')
      .select(['id', 'title', 'content'])
      .where('id', 'in', pageIds)
      .where('workspaceId', '=', payload.workspaceId)
      .where('deletedAt', 'is', null)
      .execute();

    const byId = new Map(rows.map((row) => [row.id, row]));

    // Emit in the order authorization resolved them, not the order Postgres
    // returned, so the document follows the page tree.
    return {
      pages: pageIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((page) => ({
          pageId: page.id,
          title: page.title || 'Untitled',
          content: page.content,
        })),
    };
  }

  /**
   * Depth-first walk so the PDF reads in the same order as the sidebar tree,
   * skipping any subpage this user cannot open. Capped because one runaway tree
   * should not turn into a thousand-page render.
   */
  private async collectViewablePageIds(
    root: Page,
    user: User,
  ): Promise<string[]> {
    const ordered: string[] = [root.id];
    const queue: string[] = [root.id];

    while (queue.length > 0 && ordered.length < MAX_PAGES_PER_EXPORT) {
      const parentId = queue.shift();

      const children = await this.db
        .selectFrom('pages')
        .selectAll()
        .where('parentPageId', '=', parentId)
        .where('spaceId', '=', root.spaceId)
        .where('deletedAt', 'is', null)
        .orderBy('position', 'asc')
        .execute();

      for (const child of children) {
        if (ordered.length >= MAX_PAGES_PER_EXPORT) break;

        try {
          await this.pageAccessService.validateCanView(child as Page, user);
        } catch {
          // Restricted for this user: skip it and its subtree, exactly as the
          // sidebar would.
          continue;
        }

        ordered.push(child.id);
        queue.unshift(child.id);
      }
    }

    return ordered;
  }

  /* ------------------------------------------------------------ generation */

  async generateAndStorePdf(fileTaskId: string): Promise<void> {
    const fileTask = await this.db
      .selectFrom('fileTasks')
      .selectAll()
      .where('id', '=', fileTaskId)
      .executeTakeFirst();

    if (!fileTask) {
      throw notFound('error.common.file_task_not_found');
    }

    if (!fileTask.pageId) {
      await this.failTask(fileTaskId, 'Export task has no page');
      return;
    }

    try {
      const token = await this.tokenService.generatePdfRenderToken(
        fileTask.pageId,
        fileTask.workspaceId,
        fileTask.id,
      );

      const pdf = await this.renderPdf(fileTask.pageId, token);

      await this.storageService.upload(fileTask.filePath, pdf);

      await this.db
        .updateTable('fileTasks')
        .set({
          status: FileTaskStatus.Success,
          fileSize: pdf.length,
          updatedAt: new Date(),
        })
        .where('id', '=', fileTaskId)
        .execute();
    } catch (err: any) {
      this.logger.error(`PDF export ${fileTaskId} failed: ${err?.message}`);
      await this.failTask(fileTaskId, err?.message ?? 'PDF generation failed');
      throw err;
    }
  }

  /**
   * Prints the client's own read-only renderer rather than re-implementing
   * layout server-side, so diagrams, callouts and code blocks come out looking
   * exactly like the page on screen.
   *
   * The browser lives in a separate Gotenberg container instead of this image:
   * Chromium would add hundreds of megabytes to an image that is rebuilt and
   * pulled on every deploy, and a runaway render would compete for memory with
   * the app itself.
   */
  private async renderPdf(pageId: string, token: string): Promise<Buffer> {
    const gotenbergUrl = this.environmentService.getGotenbergUrl();
    if (!gotenbergUrl) {
      throw badRequest('error.pdf_export.pdf_export_needs_gotenberg_url_to');
    }

    const baseUrl = this.environmentService.getPdfRenderBaseUrl();
    const renderUrl = `${baseUrl.replace(/\/+$/, '')}/pdf-render/${pageId}?token=${encodeURIComponent(token)}`;

    const form = new FormData();
    form.append('url', renderUrl);
    form.append('paperWidth', '8.27'); // A4, in inches
    form.append('paperHeight', '11.7');
    form.append('marginTop', '0.7');
    form.append('marginBottom', '0.7');
    form.append('marginLeft', '0.55');
    form.append('marginRight', '0.55');
    form.append('printBackground', 'true');
    form.append('preferCssPageSize', 'false');
    // The renderer sets this flag once every page has been laid out; printing
    // earlier yields a blank or half-drawn document.
    form.append(
      'waitForExpression',
      'document.querySelector(\'[data-pdf-ready="true"]\') !== null',
    );
    form.append(
      'footer',
      new Blob([FOOTER_HTML], { type: 'text/html' }),
      'footer.html',
    );

    const response = await fetch(
      `${gotenbergUrl.replace(/\/+$/, '')}/forms/chromium/convert/url`,
      {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(
          this.environmentService.getPdfExportTimeout(),
        ),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Gotenberg returned HTTP ${response.status}: ${detail.slice(0, 300)}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private async failTask(fileTaskId: string, message: string): Promise<void> {
    await this.db
      .updateTable('fileTasks')
      .set({
        status: FileTaskStatus.Failed,
        errorMessage: message.slice(0, 500),
        updatedAt: new Date(),
      })
      .where('id', '=', fileTaskId)
      .execute();
  }

  /* -------------------------------------------------------------- download */

  async getDownload(
    fileTaskId: string,
    user: User,
    workspace: Workspace,
  ): Promise<{ fileName: string; stream: NodeJS.ReadableStream }> {
    const fileTask = await this.db
      .selectFrom('fileTasks')
      .selectAll()
      .where('id', '=', fileTaskId)
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();

    if (!fileTask || fileTask.type !== FileTaskType.Export) {
      throw notFound('error.pdf_export.export_not_found');
    }

    if (fileTask.status !== FileTaskStatus.Success) {
      throw badRequest('error.pdf_export.export_is_not_ready_yet');
    }

    // Re-check access at download time: space membership may have changed since
    // the export was queued.
    if (fileTask.pageId) {
      const page = await this.pageRepo.findById(fileTask.pageId);
      if (!page) {
        throw notFound('error.pdf_export.export_not_found');
      }
      await this.pageAccessService.validateCanView(page, user);
    }

    if (!(await this.storageService.exists(fileTask.filePath))) {
      throw notFound('error.pdf_export.export_file_has_expired');
    }

    return {
      fileName: fileTask.fileName,
      stream: await this.storageService.readStream(fileTask.filePath),
    };
  }

  /* --------------------------------------------------------------- cleanup */

  /**
   * Queued rather than run inline so a multi-instance deployment does not have
   * every instance sweeping storage at once.
   */
  @Interval('pdf-export-cleanup', 6 * 60 * 60 * 1000)
  async scheduleCleanup(): Promise<void> {
    await this.fileTaskQueue.add(
      QueueJob.PDF_EXPORT_CLEANUP,
      {},
      {
        jobId: 'pdf-export-cleanup',
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /** Generated PDFs are disposable; keeping them forever just fills storage. */
  async cleanupExpiredExports(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);

    const expired = await this.db
      .selectFrom('fileTasks')
      .select(['id', 'filePath'])
      .where('type', '=', FileTaskType.Export)
      .where('source', '=', 'pdf')
      .where('createdAt', '<', cutoff)
      .execute();

    for (const task of expired) {
      try {
        await this.storageService.delete(task.filePath);
      } catch {
        // Already gone, or storage is unavailable — the row still goes.
      }
      await this.db.deleteFrom('fileTasks').where('id', '=', task.id).execute();
    }

    if (expired.length > 0) {
      this.logger.debug(`Cleaned up ${expired.length} expired PDF export(s)`);
    }
  }
}
