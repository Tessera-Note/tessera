import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { EmbeddingService } from './embedding.service';

type PageJob = { pageIds?: string[]; workspaceId?: string };

/**
 * Consumes AI_QUEUE. Until this existed the queue had no worker at all, so
 * page events piled up in Redis indefinitely — and Redis runs with
 * maxmemory-policy noeviction, where a full instance starts refusing writes.
 */
@Processor(QueueName.AI_QUEUE)
export class EmbeddingProcessor extends WorkerHost {
  private readonly logger = new Logger(EmbeddingProcessor.name);

  constructor(private readonly embeddingService: EmbeddingService) {
    super();
  }

  async process(job: Job<PageJob>): Promise<void> {
    const pageIds = job.data?.pageIds ?? [];
    const workspaceId = job.data?.workspaceId;

    switch (job.name) {
      // Задачи уровня рабочего пространства приходят без `pageIds`. Раньше
      // разбор начинался с выхода по пустому списку, и обе такие задачи молча
      // уходили в никуда: администратору сообщалось о поставленной
      // переиндексации, которой не происходило.
      case QueueJob.WORKSPACE_DELETE_EMBEDDINGS: {
        if (!workspaceId) return;
        const removed = await this.embeddingService.removeWorkspace(
          workspaceId,
        );
        this.logger.debug(
          `Removed ${removed} embedding row(s) of workspace ${workspaceId}`,
        );
        return;
      }

      case QueueJob.WORKSPACE_CREATE_EMBEDDINGS: {
        if (!workspaceId) return;
        if (!(await this.embeddingService.isConfigured(workspaceId))) {
          this.logger.debug(
            `Skipping ${job.name}: no embedding provider configured`,
          );
          return;
        }

        const { indexed, failed } =
          await this.embeddingService.indexWorkspace(workspaceId);
        this.logger.log(
          `Reindexed workspace ${workspaceId}: ${indexed} page(s) indexed, ${failed} failed`,
        );
        return;
      }
    }

    if (pageIds.length === 0) return;

    switch (job.name) {
      case QueueJob.PAGE_DELETED:
      case QueueJob.PAGE_SOFT_DELETED:
        // Removal must work even without an API key, otherwise deleted pages
        // stay searchable.
        for (const pageId of pageIds) {
          await this.embeddingService.removePage(pageId);
        }
        return;

      case QueueJob.PAGE_CREATED:
      case QueueJob.PAGE_UPDATED:
      case QueueJob.PAGE_CONTENT_UPDATED:
      case QueueJob.PAGE_RESTORED: {
        if (!(await this.embeddingService.isConfigured(workspaceId))) {
          // Draining rather than failing: with no key configured these jobs
          // would retry forever and refill the backlog this worker exists to
          // clear.
          this.logger.debug(
            `Skipping ${job.name}: no embedding provider configured`,
          );
          return;
        }

        for (const pageId of pageIds) {
          try {
            const { chunks } = await this.embeddingService.indexPage(pageId);
            this.logger.debug(`Indexed page ${pageId} into ${chunks} chunk(s)`);
          } catch (err: any) {
            // One bad page should not poison the batch.
            this.logger.warn(
              `Failed to index page ${pageId}: ${err?.message ?? err}`,
            );
          }
        }
        return;
      }

      default:
        // Unknown job names are acknowledged so they leave the queue instead
        // of accumulating forever.
        this.logger.debug(`Ignoring unhandled AI queue job: ${job.name}`);
    }
  }
}
