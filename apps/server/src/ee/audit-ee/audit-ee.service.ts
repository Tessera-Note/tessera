import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { sql } from 'kysely';
import { Interval } from '@nestjs/schedule';
import { executeTx } from '@tessera/db/utils';
import { executeWithCursorPagination } from '@tessera/db/pagination/cursor-pagination';
import { AuditLogListDto } from './dto/audit.dto';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import {
  AuditLogPayload,
  ActorType,
  EXCLUDED_AUDIT_EVENTS,
} from '../../common/events/audit-events';
import {
  AuditLogContext,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  AuditContext,
  AUDIT_CONTEXT_KEY,
} from '../../common/middlewares/audit-context.middleware';
import { badRequest } from '../../common/errors/app-error';

/**
 * Ключ консультативной блокировки прохода по сроку хранения. Отличается от
 * ключа прохода по срокам верификации, иначе две разные задачи блокировали бы
 * друг друга.
 */
const RETENTION_LOCK_KEY = 815_042_002;

/**
 * Запись, уходящая в очередь. Отличается от AuditLogPayload тем, что контекст
 * уже разрешен: обработчик очереди работает вне запроса и до CLS не доберется.
 */
export type AuditJobData = {
  workspaceId: string;
  actorId: string | null;
  actorType: ActorType;
  event: string;
  resourceType: string;
  resourceId: string | null;
  spaceId: string | null;
  changedFields: string[] | null;
  metadata: Record<string, any> | null;
  ipAddress: string | null;
  createdAt: string;
};

/**
 * Запись событий аудита.
 *
 * Заменяет NoopAuditService. Вызовы аудита расставлены по горячим путям,
 * включая просмотр страницы и вход, поэтому запись идет через очередь:
 * синхронная вставка в базу на каждое действие деградировала бы основной
 * путь. Потеря отдельных событий при сбое очереди принята как приемлемая
 * плата, отказ постановки не пробрасывается наверх.
 */
@Injectable()
export class AuditEeService implements IAuditService {
  private readonly logger = new Logger(AuditEeService.name);

  constructor(
    @InjectQueue(QueueName.AUDIT_QUEUE) private readonly auditQueue: Queue,
    private readonly cls: ClsService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * Имена измененных полей вместо самих значений.
   *
   * Содержимое страниц в журнал не попадает: журнал читает администратор
   * рабочего пространства, которому доступ к самим страницам может быть
   * не открыт. Имена берутся объединением ключей обеих сторон, потому что
   * часть вызовов заполняет только before, часть только after.
   */
  private collectChangedFields(
    changes: AuditLogPayload['changes'],
  ): string[] | null {
    if (!changes) return null;
    const names = new Set<string>([
      ...Object.keys(changes.before ?? {}),
      ...Object.keys(changes.after ?? {}),
    ]);
    return names.size > 0 ? Array.from(names).sort() : null;
  }

  /** Контекст запроса из CLS, при его отсутствии пустой. */
  private readContext(): Partial<AuditContext> {
    try {
      return this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY) ?? {};
    } catch {
      // Вне запроса CLS может быть не поднят, это не ошибка.
      return {};
    }
  }

  private buildJob(
    payload: AuditLogPayload,
    context: AuditLogContext,
  ): AuditJobData {
    return {
      workspaceId: context.workspaceId,
      actorId: context.actorId ?? null,
      actorType: context.actorType ?? 'user',
      event: payload.event,
      resourceType: payload.resourceType,
      resourceId: payload.resourceId ?? null,
      spaceId: payload.spaceId ?? null,
      changedFields: this.collectChangedFields(payload.changes),
      metadata: payload.metadata ?? null,
      ipAddress: context.ipAddress ?? null,
      // Время события фиксируется при постановке, а не при разборе очереди:
      // иначе задержка обработки искажала бы порядок в журнале.
      createdAt: new Date().toISOString(),
    };
  }

  /** Событие из списка исключенных не пишется. */
  private isExcluded(event: string): boolean {
    return EXCLUDED_AUDIT_EVENTS.has(event);
  }

  private async enqueue(jobs: AuditJobData[]): Promise<void> {
    if (jobs.length === 0) return;
    try {
      await this.auditQueue.addBulk(
        jobs.map((data) => ({
          name: QueueJob.AUDIT_LOG,
          data,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
          },
        })),
      );
    } catch (err) {
      // Сбой очереди не должен ронять действие пользователя.
      this.logger.warn(
        `Не удалось поставить событие аудита в очередь: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async log(payload: AuditLogPayload): Promise<void> {
    const context = this.readContext();
    if (!context.workspaceId) {
      this.logger.debug(
        `Событие ${payload.event} пропущено: рабочее пространство в контексте не определено`,
      );
      return;
    }
    await this.logWithContext(payload, {
      workspaceId: context.workspaceId,
      actorId: context.actorId ?? undefined,
      actorType: context.actorType ?? 'user',
      ipAddress: context.ipAddress ?? undefined,
    });
  }

  async logWithContext(
    payload: AuditLogPayload,
    context: AuditLogContext,
  ): Promise<void> {
    if (this.isExcluded(payload.event)) return;
    if (!context?.workspaceId) return;
    await this.enqueue([this.buildJob(payload, context)]);
  }

  async logBatchWithContext(
    payloads: AuditLogPayload[],
    context: AuditLogContext,
  ): Promise<void> {
    if (!context?.workspaceId) return;
    const jobs = payloads
      .filter((payload) => !this.isExcluded(payload.event))
      .map((payload) => this.buildJob(payload, context));
    await this.enqueue(jobs);
  }

  /**
   * Актор в контексте запроса.
   *
   * Контекст живет в CLS, поэтому правка видна только текущему запросу
   * и не протекает в соседние.
   */
  setActorId(actorId: string): void {
    const context = this.readContext();
    if (!context || Object.keys(context).length === 0) return;
    this.cls.set(AUDIT_CONTEXT_KEY, { ...context, actorId });
  }

  setActorType(actorType: ActorType): void {
    const context = this.readContext();
    if (!context || Object.keys(context).length === 0) return;
    this.cls.set(AUDIT_CONTEXT_KEY, { ...context, actorType });
  }

  /**
   * Страница журнала.
   *
   * Автор и ресурс разрешаются в объекты здесь, а не отдаются
   * идентификаторами: клиент объявляет именно объекты, и выдача сырых строк
   * таблицы уже приводила к неработающему экрану в верификации страниц.
   */
  async listLogs(params: AuditLogListDto, workspaceId: string) {
    let query = this.db
      .selectFrom('audit')
      .selectAll('audit')
      .where('workspaceId', '=', workspaceId);

    if (params.event) query = query.where('event', '=', params.event);
    if (params.resourceType) {
      query = query.where('resourceType', '=', params.resourceType);
    }
    if (params.actorId) query = query.where('actorId', '=', params.actorId);
    if (params.spaceId) query = query.where('spaceId', '=', params.spaceId);
    if (params.startDate) {
      query = query.where('createdAt', '>=', new Date(params.startDate));
    }
    if (params.endDate) {
      query = query.where('createdAt', '<=', new Date(params.endDate));
    }

    const result = await executeWithCursorPagination(query, {
      perPage: params.limit ?? 20,
      cursor: params.cursor,
      beforeCursor: params.beforeCursor,
      fields: [
        { expression: 'createdAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor: any) => ({
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      }),
    });

    const rows: any[] = result.items;
    const actors = await this.loadActors(rows.map((row) => row.actorId));

    // meta отдается как есть: помощник пагинации уже строит ту форму,
    // которую объявляет клиент.
    return {
      meta: result.meta,
      items: rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        actorId: row.actorId ?? undefined,
        actorType: row.actorType,
        event: row.event,
        resourceType: row.resourceType,
        resourceId: row.resourceId ?? undefined,
        spaceId: row.spaceId ?? undefined,
        changes: row.changes ?? undefined,
        metadata: row.metadata ?? undefined,
        ipAddress: row.ipAddress ?? undefined,
        createdAt: row.createdAt,
        actor: row.actorId ? (actors.get(row.actorId) ?? undefined) : undefined,
      })),
    };
  }

  /** Авторы событий одним запросом на страницу выдачи. */
  private async loadActors(
    actorIds: (string | null | undefined)[],
  ): Promise<Map<string, any>> {
    const unique = Array.from(
      new Set(actorIds.filter((id): id is string => !!id)),
    );
    if (unique.length === 0) return new Map();

    const users = await this.db
      .selectFrom('users')
      .select(['id', 'name', 'email', 'avatarUrl'])
      .where('id', 'in', unique)
      .execute();

    return new Map(
      users.map((user) => [
        user.id,
        {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl ?? undefined,
        },
      ]),
    );
  }

  /** Текущий срок хранения журнала. */
  async getRetention(workspaceId: string): Promise<{ retentionDays: number }> {
    const workspace = await this.db
      .selectFrom('workspaces')
      .select('auditRetentionDays')
      .where('id', '=', workspaceId)
      .executeTakeFirst();

    return { retentionDays: workspace?.auditRetentionDays ?? 0 };
  }

  /**
   * Проход по сроку хранения журнала.
   *
   * Устроен так же, как проход по срокам верификации: часовой такт и
   * консультативная блокировка, чтобы при нескольких репликах чистило
   * только одно приложение. Блокировка транзакционная, зависший экземпляр
   * ее не удержит.
   *
   * Ноль означает хранить вечно, поэтому такие пространства пропускаются
   * прямо в условии запроса.
   */
  @Interval('audit-retention', 60 * 60 * 1000)
  async purgeExpiredLogs(): Promise<number> {
    try {
      return await executeTx(this.db, async (trx) => {
        const locked = await this.tryAcquireRetentionLock(trx);
        if (!locked) {
          this.logger.debug(
            'Проход по сроку хранения журнала пропущен: занят другой репликой',
          );
          return 0;
        }

        const removed = await this.deleteExpiredLogs(trx);
        if (removed > 0) {
          this.logger.log(`Записей журнала удалено по сроку: ${removed}`);
        }
        return removed;
      });
    } catch (err) {
      this.logger.error(
        'Проход по сроку хранения журнала не удался',
        err instanceof Error ? err.stack : String(err),
      );
      return 0;
    }
  }

  /**
   * Взять консультативную блокировку прохода.
   *
   * Вынесено отдельным методом ради проверяемости: подменить sql на уровне
   * модуля не получается, а поведение при занятой блокировке проверять надо.
   */
  private async tryAcquireRetentionLock(trx: any): Promise<boolean> {
    const lock = await sql<{ locked: boolean }>`
      SELECT pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY}) AS locked
    `.execute(trx);
    return lock.rows[0]?.locked === true;
  }

  /**
   * Удалить записи, вышедшие за срок хранения своего пространства.
   *
   * Условие audit_retention_days > 0 и есть реализация правила «ноль означает
   * хранить вечно»: такие пространства не попадают в выборку вовсе.
   */
  private async deleteExpiredLogs(trx: any): Promise<number> {
    const result = await sql<{ count: string }>`
      WITH removed AS (
        DELETE FROM audit a
        USING workspaces w
        WHERE w.id = a.workspace_id
          AND w.audit_retention_days > 0
          AND a.created_at < now() - (w.audit_retention_days * INTERVAL '1 day')
        RETURNING a.id
      )
      SELECT count(*)::text AS count FROM removed
    `.execute(trx);
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Срок хранения журнала в днях.
   *
   * Ноль означает хранить вечно, поэтому отрицательные значения отсекаются,
   * а не приводятся к нулю: иначе опечатка со знаком молча включала бы
   * бессрочное хранение. Сам проход по сроку идет отдельной задачей.
   */
  async updateRetention(
    workspaceId: string,
    retentionDays: number,
  ): Promise<void> {
    if (!Number.isInteger(retentionDays) || retentionDays < 0) {
      throw badRequest('error.audit.retention_invalid');
    }

    await this.db
      .updateTable('workspaces')
      .set({ auditRetentionDays: retentionDays } as any)
      .where('id', '=', workspaceId)
      .execute();
  }
}
