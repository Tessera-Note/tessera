import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';
import { EnvironmentService } from '../../integrations/environment/environment.service';

export class PageEvent {
  pageIds: string[];
  workspaceId: string;
}

@Injectable()
export class PageListener {
  private readonly logger = new Logger(PageListener.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    @InjectQueue(QueueName.SEARCH_QUEUE) private searchQueue: Queue,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
  ) {}

  @OnEvent(EventName.PAGE_CREATED)
  async handlePageCreated(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_CREATED, {
        pageIds,
      });
    }

    await this.aiQueue.add(QueueJob.PAGE_CREATED, { pageIds, workspaceId });
  }

  @OnEvent(EventName.PAGE_UPDATED)
  async handlePageUpdated(event: PageEvent) {
    const { pageIds, workspaceId } = event;

    // Проверка драйвера была у четырех постановок из пяти, а здесь ее не
    // было. Очередь поиска обслуживается только при `SEARCH_DRIVER=typesense`,
    // а обработчика у нее в этой сборке нет вовсе, поэтому каждое сохранение
    // страницы навсегда откладывало задачу в Redis. Замерено на стенде: 139
    // задач `page-updated` ждали несуществующего обработчика, а Redis работает
    // с `maxmemory-policy noeviction`, где переполнение начинает отказывать в
    // записи.
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_UPDATED, { pageIds });
    }

    // Without this an edited page keeps its original embeddings, so semantic
    // search would answer from stale content.
    await this.aiQueue.add(QueueJob.PAGE_UPDATED, { pageIds, workspaceId });
  }

  @OnEvent(EventName.PAGE_DELETED)
  async handlePageDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_DELETED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_DELETED, { pageIds, workspaceId });
  }

  @OnEvent(EventName.PAGE_SOFT_DELETED)
  async handlePageSoftDeleted(event: PageEvent) {
    const { pageIds, workspaceId } = event;

    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_SOFT_DELETED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_SOFT_DELETED, {
      pageIds,
      workspaceId,
    });
  }

  @OnEvent(EventName.PAGE_RESTORED)
  async handlePageRestored(event: PageEvent) {
    const { pageIds, workspaceId } = event;
    if (this.isTypesense()) {
      await this.searchQueue.add(QueueJob.PAGE_RESTORED, { pageIds });
    }

    await this.aiQueue.add(QueueJob.PAGE_RESTORED, { pageIds, workspaceId });
  }

  isTypesense(): boolean {
    return this.environmentService.getSearchDriver() === 'typesense';
  }
}
