import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { sql } from 'kysely';
import { executeTx } from '@tessera/db/utils';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
import { BaseRepo } from '@tessera/db/repos/base/base.repo';
import { BaseWsService } from './realtime/base-ws.service';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { generateSlugId } from '../../common/helpers';
import { randomUUID } from 'crypto';
import {
  CreateBaseDto,
  UpdateBaseDto,
  CreatePropertyDto,
  UpdatePropertyDto,
  CreateRowDto,
  UpdateRowDto,
  ListRowsDto,
  CreateViewDto,
  UpdateViewDto,
} from './dto/base.dto';
import { matchesBaseRowFilter, collectPushdownConditions } from './base-filter';
import { badRequest, notFound } from '../../common/errors/app-error';

/**
 * Значение для jsonb-колонки.
 *
 * Приведение `::text::jsonb` обязательно: без `::text` драйвер отдает параметр
 * как значение json-строки, и в колонку ложится скаляр, а не объект. Именно так
 * модуль исторически и писал, из-за чего SQL-выражения над этими колонками
 * падали с `cannot set path in scalar`.
 */
function toJsonb(value: unknown) {
  // Тип выражения задается явно: Kysely выводит RawBuilder<unknown>, который
  // не подходит под тип jsonb-колонки.
  return sql<any>`${JSON.stringify(value ?? {})}::text::jsonb`;
}

/** Разбор jsonb-полей свойства для выдачи наружу. */
function formatProperty(property: any) {
  return {
    ...property,
    typeOptions: property.typeOptions || {},
  };
}

/** Разбор jsonb-поля представления для выдачи наружу. */
function formatView(view: any) {
  return {
    ...view,
    config: view.config || {},
  };
}

/** Предел выгрузки в CSV. Больше этого объёма нужен потоковый экспорт. */
const CSV_EXPORT_ROW_LIMIT = 10000;

function getNextPosition(lastPos?: string): string {
  if (!lastPos) return 'h0';
  const charCode = lastPos.charCodeAt(lastPos.length - 1);
  if (charCode < 122) {
    // 'z'
    return lastPos.slice(0, -1) + String.fromCharCode(charCode + 1);
  }
  return lastPos + 'h';
}

@Injectable()
export class BaseService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly baseWs: BaseWsService,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly baseRepo: BaseRepo,
  ) {}

  /**
   * Метаданные страниц для ячеек типа «страница».
   *
   * Клиент батчит запросы в один вызов (`page-expand-loader.ts`) и ждет форму
   * `{ items }` с полями `ResolvedPage`. Выдача проходит два фильтра: членство
   * в пространстве прямо в запросе и ограничения на уровне страницы через
   * PagePermissionRepo. Одной проверки членства недостаточно: страница может
   * быть закрыта внутри пространства, участником которого пользователь
   * является.
   */
  async expandPages(pageIds: string[], userId: string, workspaceId: string) {
    if (pageIds.length === 0) return { items: [] };

    const rows = await this.baseRepo.findPagesInUserSpaces(
      pageIds,
      userId,
      workspaceId,
    );

    if (rows.length === 0) return { items: [] };

    const accessibleIds = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: rows.map((row) => row.id),
        userId,
      }),
    );

    return {
      items: rows
        .filter((row) => accessibleIds.has(row.id))
        .map((row) => ({
          id: row.id,
          slugId: row.slugId,
          title: row.title,
          icon: row.icon,
          spaceId: row.spaceId,
          space: row.spaceSlug
            ? { id: row.spaceId, slug: row.spaceSlug, name: row.spaceName }
            : null,
        })),
    };
  }

  async createBase(dto: CreateBaseDto, userId: string, workspaceId: string) {
    let spaceId = dto.spaceId;
    const parentPageId = dto.parentPageId || null;

    // Родитель проверяется всегда, когда он задан, а не только когда spaceId
    // опущен. Иначе при передаче обоих полей страница получала space одного
    // пространства и родителя из другого, а обходы предков начинали ходить
    // через эту связь.
    if (parentPageId) {
      const parentPage = await this.db
        .selectFrom('pages')
        .select('spaceId')
        .where('id', '=', parentPageId)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();

      if (!parentPage) {
        throw notFound('error.common.parent_page_not_found');
      }
      if (spaceId && parentPage.spaceId !== spaceId) {
        throw badRequest('error.base.parent_page_belongs_to_a_different');
      }
      spaceId = parentPage.spaceId;
    }

    if (!spaceId) {
      throw badRequest('error.common.spaceid_or_parentpageid_is_required');
    }

    const title =
      dto.name || (dto.template === 'kanban' ? 'Kanban' : 'Untitled');
    const pageId = dto.pageId || randomUUID();

    const isKanban = dto.template === 'kanban';
    const position = await this.pageService.nextPagePosition(
      spaceId,
      parentPageId ?? undefined,
    );

    // Страница, свойства и представление создаются одной транзакцией. Иначе
    // сбой на любом шаге оставляет полурожденную базу: страницу с признаком
    // is_base, но без представления, которую нельзя открыть.
    await executeTx(this.db, async (trx) => {
      // Вставка идет через PageRepo, а не напрямую: так уходит PAGE_CREATED,
      // от которого зависят индексация и очередь эмбеддингов, а slugId и
      // position берутся общим для всех страниц способом.
      const page = await this.pageRepo.insertPage(
        {
          id: pageId,
          title,
          isBase: true,
          baseSchemaVersion: 1,
          spaceId,
          parentPageId,
          workspaceId,
          creatorId: userId,
          lastUpdatedById: userId,
          slugId: generateSlugId(),
          position,
          icon: dto.icon ?? null,
          // pages.content тоже jsonb: JSON.stringify клал сюда json-строку,
          // из-за чего экспорт пространства и дублирование такой страницы
          // падали на попытке прочитать документ.
          content: toJsonb({ type: 'doc', content: [] }),
        } as any,
        trx,
      );

      await trx
        .insertInto('baseProperties')
        .values({
          id: randomUUID().substring(0, 8),
          pageId: page.id,
          workspaceId,
          name: 'Title',
          type: 'title',
          position: 'h0',
          isPrimary: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute();

      const selectPropId = isKanban
        ? await this.insertStatusProperty(trx, page.id, workspaceId, 'h1')
        : undefined;

      await trx
        .insertInto('baseViews')
        .values({
          id: randomUUID(),
          pageId: page.id,
          workspaceId,
          name: isKanban ? 'Board' : 'Grid',
          type: isKanban ? 'kanban' : 'table',
          position: 'h0',
          // base_views.config объявлена NOT NULL с умолчанием '{}'. Явный null
          // перебивает умолчание и роняет вставку, поэтому для представления
          // без группировки пишем пустой объект.
          config: toJsonb(
            selectPropId ? { groupByPropertyId: selectPropId } : {},
          ),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute();
    });

    return this.getBaseInfo(pageId, workspaceId);
  }

  /**
   * Поднять версию схемы base.
   *
   * Клиент при подписке сверяет версию с той, под которой построен его кеш, и
   * перезапрашивает данные при расхождении. Без инкремента он показывал бы
   * устаревший состав свойств и представлений, ничего об этом не зная.
   * Вызывается только внутри транзакции самого изменения.
   */
  private async bumpSchemaVersion(
    trx: KyselyTransaction,
    pageId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.baseRepo.bumpSchemaVersion(pageId, workspaceId, trx);
  }

  /**
   * Свойство «Status» для доски канбана.
   *
   * Ключ именно `choices` с порядком в `choiceOrder`: клиент читает варианты
   * выбора только в этой форме (`base.types.ts`, `SelectTypeOptions`). Любой
   * другой ключ дает пустой список статусов и одну колонку «нет значения».
   */
  private async insertStatusProperty(
    trx: KyselyTransaction,
    pageId: string,
    workspaceId: string,
    position: string,
    takenNames: string[] = [],
  ): Promise<string> {
    const propertyId = randomUUID().substring(0, 8);
    // base_properties_page_name_alive_unique строит уникальность по
    // (page_id, lower(trim(name))). Если имя занято живым свойством, вставка
    // даст 23505 и откатит всю транзакцию конверта.
    const taken = new Set(takenNames.map((name) => name.trim().toLowerCase()));
    let name = 'Status';
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) {
      name = `Status ${suffix}`;
    }
    const choices = [
      {
        id: randomUUID().substring(0, 8),
        name: 'To Do',
        color: 'gray',
        category: 'todo',
      },
      {
        id: randomUUID().substring(0, 8),
        name: 'In Progress',
        color: 'blue',
        category: 'inProgress',
      },
      {
        id: randomUUID().substring(0, 8),
        name: 'Done',
        color: 'green',
        category: 'complete',
      },
    ];

    await trx
      .insertInto('baseProperties')
      .values({
        id: propertyId,
        pageId,
        workspaceId,
        name,
        type: 'select',
        position,
        isPrimary: false,
        typeOptions: toJsonb({
          choices,
          choiceOrder: choices.map((choice) => choice.id),
        }),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();

    return propertyId;
  }

  /**
   * Состав base.
   *
   * `permissions` заполняется только там, где права уже вычислены вызывающим
   * кодом (эндпоинт info). Ответы на мутации это поле не несут: у них нет
   * данных о правах, а прежняя константа canEdit: true вводила клиент
   * в заблуждение. Поле объявлено необязательным и на клиенте.
   */
  async getBaseInfo(
    pageId: string,
    workspaceId: string,
    permissions?: { canEdit: boolean; hasRestriction: boolean },
  ) {
    const page = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('id', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!page) {
      throw notFound('error.common.base_not_found');
    }

    const properties = await this.db
      .selectFrom('baseProperties')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('position asc')
      .execute();

    const views = await this.db
      .selectFrom('baseViews')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('position asc')
      .execute();

    // Parse typeOptions and config JSON fields
    const formattedProperties = properties.map((p) => ({
      ...p,
      typeOptions: p.typeOptions || {},
    }));

    const formattedViews = views.map((v) => ({
      ...v,
      config: v.config || {},
    }));

    return {
      id: page.id,
      slugId: page.slugId,
      name: page.title,
      spaceId: page.spaceId,
      workspaceId: page.workspaceId,
      creatorId: page.creatorId,
      properties: formattedProperties,
      views: formattedViews,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      baseSchemaVersion: page.baseSchemaVersion,
      ...(permissions ? { permissions } : {}),
    };
  }

  async updateBase(dto: UpdateBaseDto, workspaceId: string) {
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.title = dto.name;
    // description и icon принимались в DTO и никуда не писались.
    if (dto.icon !== undefined) updateData.icon = dto.icon;

    await this.db
      .updateTable('pages')
      .set(updateData)
      .where('id', '=', dto.pageId)
      .where('workspaceId', '=', workspaceId)
      .execute();

    return this.getBaseInfo(dto.pageId, workspaceId);
  }

  /**
   * Мягкое удаление базы.
   *
   * Через PageRepo, а не прямым update: иначе не уходит PAGE_SOFT_DELETED,
   * потомки не помечаются, ссылки на общий доступ не чистятся, а эмбеддинги
   * удаленной базы остаются в базе навсегда.
   */
  async deleteBase(pageId: string, userId: string, workspaceId: string) {
    await this.pageRepo.removePage(pageId, userId, workspaceId);
  }

  async convertPageToBase(
    pageId: string,
    template: string | undefined,
    userId: string,
    workspaceId: string,
  ) {
    const isKanban = template === 'kanban';

    // Признак базы, свойства и представление ставятся одной транзакцией: иначе
    // сбой между шагами оставляет страницу с is_base, но без представления.
    await executeTx(this.db, async (trx) => {
      await trx
        .updateTable('pages')
        .set({
          isBase: true,
          baseSchemaVersion: 1,
          updatedAt: new Date(),
        })
        .where('id', '=', pageId)
        .where('workspaceId', '=', workspaceId)
        .execute();

      const existingProps = await trx
        .selectFrom('baseProperties')
        .select(['id', 'type', 'name'])
        .where('pageId', '=', pageId)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute();

      if (existingProps.length === 0) {
        await trx
          .insertInto('baseProperties')
          .values({
            id: randomUUID().substring(0, 8),
            pageId,
            name: 'Title',
            // Тот же тип, что и у базы, созданной с нуля. С типом text
            // первичное свойство рисовалось как обычный текст.
            type: 'title',
            position: 'h0',
            isPrimary: true,
            schemaVersion: 1,
            workspaceId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .execute();
      }

      // Доске нужно свойство группировки. Если подходящего нет, заводим его,
      // иначе канбан открывался пустым экраном «нет свойства группировки».
      let groupByPropertyId = existingProps.find(
        (property) => property.type === 'select' || property.type === 'status',
      )?.id;

      if (isKanban && !groupByPropertyId) {
        groupByPropertyId = await this.insertStatusProperty(
          trx,
          pageId,
          workspaceId,
          'h1',
          existingProps.map((property) => property.name),
        );
      }

      const existingViews = await trx
        .selectFrom('baseViews')
        .select('id')
        .where('pageId', '=', pageId)
        .where('workspaceId', '=', workspaceId)
        .execute();

      if (existingViews.length === 0) {
        await trx
          .insertInto('baseViews')
          .values({
            id: randomUUID(),
            pageId,
            name: isKanban ? 'Board' : 'Table',
            type: isKanban ? 'kanban' : 'table',
            position: 'h0',
            config: toJsonb(
              isKanban && groupByPropertyId ? { groupByPropertyId } : {},
            ),
            workspaceId,
            creatorId: userId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .execute();
      }
    });

    return this.getBaseInfo(pageId, workspaceId);
  }

  /**
   * Базы пространства.
   *
   * Членства в пространстве недостаточно: отдельная база внутри него может
   * быть закрыта ограничениями страницы, а выдача несет ее состав, свойства и
   * представления. Тот же двойной фильтр, что и в expandPages; двойник этого
   * вызова в MCP фильтрует так же.
   */
  async listBases(spaceId: string, workspaceId: string, userId: string) {
    const bases = await this.baseRepo.findBaseIdsInSpace(spaceId, workspaceId);

    if (bases.length === 0) return { items: [] };

    const accessibleIds = await this.pagePermissionRepo.filterAccessiblePageIds(
      {
        pageIds: bases.map((base) => base.id),
        userId,
        spaceId,
      },
    );

    if (accessibleIds.length === 0) return { items: [] };

    // Раньше здесь шёл getBaseInfo в цикле, то есть три запроса на каждую
    // доступную базу. Теперь три запроса на весь список независимо от его
    // длины: страницы, свойства и представления читаются пакетом.
    const [pages, properties, views] = await Promise.all([
      this.db
        .selectFrom('pages')
        .selectAll()
        .where('id', 'in', accessibleIds)
        .where('workspaceId', '=', workspaceId)
        .execute(),
      this.db
        .selectFrom('baseProperties')
        .selectAll()
        .where('pageId', 'in', accessibleIds)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .orderBy('position asc')
        .execute(),
      this.db
        .selectFrom('baseViews')
        .selectAll()
        .where('pageId', 'in', accessibleIds)
        .where('workspaceId', '=', workspaceId)
        .orderBy('position asc')
        .execute(),
    ]);

    const groupByPage = <T extends { pageId: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) {
        const existing = map.get(row.pageId);
        if (existing) existing.push(row);
        else map.set(row.pageId, [row]);
      }
      return map;
    };

    const propertiesByPage = groupByPage(properties);
    const viewsByPage = groupByPage(views);

    const items = pages.map((page) => ({
      id: page.id,
      slugId: page.slugId,
      name: page.title,
      spaceId: page.spaceId,
      workspaceId: page.workspaceId,
      creatorId: page.creatorId,
      properties: (propertiesByPage.get(page.id) ?? []).map(formatProperty),
      views: (viewsByPage.get(page.id) ?? []).map(formatView),
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      baseSchemaVersion: page.baseSchemaVersion,
    }));

    return { items };
  }

  // Properties CRUD
  async createProperty(dto: CreatePropertyDto, workspaceId: string) {
    const id = randomUUID().substring(0, 8);

    const lastProp = await this.db
      .selectFrom('baseProperties')
      .select('position')
      .where('pageId', '=', dto.pageId)
      .where('deletedAt', 'is', null)
      .orderBy('position desc')
      .executeTakeFirst();

    const position = getNextPosition(lastProp?.position);

    const prop = await executeTx(this.db, async (trx) => {
      const inserted = await trx
        .insertInto('baseProperties')
        .values({
          id,
          pageId: dto.pageId,
          name: dto.name,
          type: dto.type as any,
          position,
          typeOptions: dto.typeOptions ? toJsonb(dto.typeOptions) : null,
          isPrimary: false,
          schemaVersion: 1,
          workspaceId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.bumpSchemaVersion(trx, dto.pageId, workspaceId);
      return inserted;
    });

    const property = {
      ...prop,
      typeOptions: dto.typeOptions || {},
    };
    this.baseWs.emitToBase(dto.pageId, {
      operation: 'base:property:created',
      property,
    });
    return property;
  }

  async updateProperty(dto: UpdatePropertyDto, workspaceId: string) {
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.type !== undefined) updateData.type = dto.type;
    if (dto.typeOptions !== undefined) {
      // null и undefined различаются: отсутствие поля значит «не трогать»,
      // явный null значит «сбросить в SQL NULL». Через toJsonb с `?? {}`
      // сброс был недостижим, свойство получало пустой объект.
      updateData.typeOptions =
        dto.typeOptions === null ? null : toJsonb(dto.typeOptions);
    }

    const prop = await executeTx(this.db, async (trx) => {
      const updated = await trx
        .updateTable('baseProperties')
        .set(updateData)
        .where('id', '=', dto.propertyId)
        .where('pageId', '=', dto.pageId)
        .where('workspaceId', '=', workspaceId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.bumpSchemaVersion(trx, dto.pageId, workspaceId);
      return updated;
    });

    const property = {
      ...prop,
      typeOptions: dto.typeOptions || prop.typeOptions || {},
    };
    this.baseWs.emitToBase(dto.pageId, {
      operation: 'base:property:updated',
      property,
    });
    return { property, jobId: null };
  }

  async deleteProperty(
    propertyId: string,
    pageId: string,
    workspaceId: string,
  ) {
    await executeTx(this.db, async (trx) => {
      await trx
        .updateTable('baseProperties')
        .set({ deletedAt: new Date() })
        .where('id', '=', propertyId)
        .where('pageId', '=', pageId)
        .where('workspaceId', '=', workspaceId)
        .execute();
      await this.bumpSchemaVersion(trx, pageId, workspaceId);
    });

    this.baseWs.emitToBase(pageId, {
      operation: 'base:property:deleted',
      propertyId,
    });
  }

  async reorderProperty(
    propertyId: string,
    pageId: string,
    position: string,
    workspaceId: string,
  ) {
    await executeTx(this.db, async (trx) => {
      await trx
        .updateTable('baseProperties')
        .set({ position, updatedAt: new Date() })
        .where('id', '=', propertyId)
        .where('pageId', '=', pageId)
        .where('workspaceId', '=', workspaceId)
        .execute();
      await this.bumpSchemaVersion(trx, pageId, workspaceId);
    });

    this.baseWs.emitToBase(pageId, {
      operation: 'base:property:reordered',
      propertyId,
    });
  }

  // Rows CRUD
  async createRow(dto: CreateRowDto, userId: string, workspaceId: string) {
    const id = randomUUID();

    const lastRow = await this.db
      .selectFrom('baseRows')
      .select('position')
      .where('pageId', '=', dto.pageId)
      .where('deletedAt', 'is', null)
      .orderBy('position desc')
      .executeTakeFirst();

    const position = dto.position || getNextPosition(lastRow?.position);

    const row = await this.db
      .insertInto('baseRows')
      .values({
        id,
        pageId: dto.pageId,
        cells: toJsonb(dto.cells),
        position,
        creatorId: userId,
        lastUpdatedById: userId,
        workspaceId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const created = {
      ...row,
      cells: dto.cells || {},
    };
    this.baseWs.emitToBase(dto.pageId, {
      operation: 'base:row:created',
      row: created,
      requestId: dto.requestId ?? null,
    });
    return created;
  }

  async getRowInfo(rowId: string, pageId: string, workspaceId: string) {
    const row = await this.db
      .selectFrom('baseRows')
      .selectAll()
      .where('id', '=', rowId)
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!row) throw notFound('error.base.row_not_found');

    return {
      ...row,
      cells: row.cells || {},
    };
  }

  /**
   * Частичное изменение ячеек строки.
   *
   * Слияние выполняет база функцией `jsonb_set_many` из миграции bases, а не
   * сервис. Прежняя схема «прочитать, слить в JS, записать целиком» затирала
   * правки соседа: двое, меняющие разные ячейки одной строки, перезаписывали
   * друг друга последним запросом. Атомарный update применяет только те
   * ключи, что пришли, и не держит блокировку строки между двумя запросами.
   *
   * Значение null в патче удаляет ключ, это семантика самой функции.
   */
  async updateRow(dto: UpdateRowDto, userId: string, workspaceId: string) {
    const updateData: any = {
      // Приведение параметра обязательно: без ::text драйвер отдает его как
      // значение json-строки, jsonb_typeof дает 'string', и функция молча
      // возвращает исходные ячейки. Разворот колонки через `#>> '{}'` больше
      // не нужен: форма закреплена ограничением base_rows_cells_is_object.
      cells: sql`jsonb_set_many(cells, ${JSON.stringify(dto.cells)}::text::jsonb)`,
      lastUpdatedById: userId,
      updatedAt: new Date(),
    };

    if (dto.position) updateData.position = dto.position;

    const row = await this.db
      .updateTable('baseRows')
      .set(updateData)
      .where('id', '=', dto.rowId)
      .where('pageId', '=', dto.pageId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw notFound('error.base.row_not_found');

    this.baseWs.emitToBase(dto.pageId, {
      operation: 'base:row:updated',
      rowId: dto.rowId,
      updatedCells: dto.cells,
      requestId: dto.requestId ?? null,
    });

    return {
      ...row,
      cells: row.cells || {},
    };
  }

  async deleteRow(
    rowId: string,
    pageId: string,
    workspaceId: string,
    requestId?: string,
  ) {
    await this.db
      .updateTable('baseRows')
      .set({ deletedAt: new Date() })
      .where('id', '=', rowId)
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .execute();

    this.baseWs.emitToBase(pageId, {
      operation: 'base:row:deleted',
      rowId,
      requestId: requestId ?? null,
    });
  }

  async deleteRows(
    rowIds: string[],
    pageId: string,
    workspaceId: string,
    requestId?: string,
  ) {
    await this.db
      .updateTable('baseRows')
      .set({ deletedAt: new Date() })
      .where('id', 'in', rowIds)
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .execute();

    this.baseWs.emitToBase(pageId, {
      operation: 'base:rows:deleted',
      rowIds,
      requestId: requestId ?? null,
    });
  }

  /**
   * Строки представления постранично.
   *
   * Выборка идет батчами с LIMIT в SQL, а не одним чтением всей базы: раньше
   * запрос тянул все живые строки и резал их в памяти, и объем рос вместе с
   * базой. Предикат фильтра по-прежнему вычисляется в приложении
   * (`base-filter.ts`), поэтому при выборочном фильтре прочитано будет больше
   * строк, чем отдано, но не больше одного батча за раз.
   *
   * Порядок «фильтр до среза» сохранен: срез делается уже по отфильтрованным
   * строкам, иначе страница отдавала бы меньше элементов, чем есть.
   */
  async listRows(dto: ListRowsDto, workspaceId: string) {
    const limit = dto.limit || 50;
    const batchSize = Math.max(limit + 1, 200);

    const matched: any[] = [];
    let cursor = dto.cursor;
    let exhausted = false;

    // Дешёвое подмножество условий считает сама база и сужает выборку.
    // Остальные операторы досчитываются на суженном наборе: относительные
    // даты и множества дешевле проверить в приложении, чем переносить их
    // семантику в SQL.
    const pushdown = collectPushdownConditions(dto.filter);

    while (matched.length <= limit && !exhausted) {
      let query = this.db
        .selectFrom('baseRows')
        .selectAll()
        .where('pageId', '=', dto.pageId)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null);

      for (const condition of pushdown) {
        const cell = sql`cells -> ${condition.propertyId}`;
        if (condition.op === 'isEmpty') {
          query = query.where(
            sql<boolean>`${cell} is null or ${cell} in ('null'::jsonb, '""'::jsonb, '[]'::jsonb)`,
          );
        } else if (condition.op === 'isNotEmpty') {
          query = query.where(
            sql<boolean>`${cell} is not null and ${cell} not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb)`,
          );
        } else if (condition.op === 'eq') {
          query = query.where(
            sql<boolean>`${cell} #>> '{}' = ${condition.value}`,
          );
        } else {
          query = query.where(
            sql<boolean>`${cell} #>> '{}' ilike ${'%' + condition.value + '%'}`,
          );
        }
      }

      if (cursor) {
        query = query.where('position', '>', cursor);
      }

      const batch = await query
        .orderBy('position asc')
        .limit(batchSize)
        .execute();

      if (batch.length < batchSize) exhausted = true;
      if (batch.length === 0) break;

      cursor = batch[batch.length - 1].position;

      for (const row of batch) {
        if (dto.filter) {
          // Форма колонки закреплена ограничением base_rows_cells_is_object,
          // поэтому это всегда объект.
          const cells = (row.cells || {}) as Record<string, unknown>;
          if (!matchesBaseRowFilter(cells, dto.filter)) continue;
        }
        matched.push(row);
        if (matched.length > limit) break;
      }
    }

    const hasMore = matched.length > limit;
    const items = matched.slice(0, limit).map((r) => ({
      ...r,
      cells: r.cells || {},
    }));

    const nextCursor = hasMore ? items[items.length - 1].position : null;

    // Fetch user mappings for references
    const creatorIds = [
      ...new Set(items.map((i) => i.creatorId).filter(Boolean)),
    ];
    const updaterIds = [
      ...new Set(items.map((i) => i.lastUpdatedById).filter(Boolean)),
    ];
    const userIds = [...new Set([...creatorIds, ...updaterIds])];

    const usersMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const dbUsers = await this.db
        .selectFrom('users')
        .select(['id', 'name', 'avatarUrl'])
        .where('id', 'in', userIds)
        .execute();

      for (const u of dbUsers) {
        usersMap[u.id] = u;
      }
    }

    return {
      items,
      meta: {
        hasMore,
        nextCursor,
      },
      references: {
        users: usersMap,
        pages: {},
      },
    };
  }

  async reorderRow(
    rowId: string,
    pageId: string,
    position: string,
    workspaceId: string,
    requestId?: string,
  ) {
    await this.db
      .updateTable('baseRows')
      .set({ position, updatedAt: new Date() })
      .where('id', '=', rowId)
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .execute();

    this.baseWs.emitToBase(pageId, {
      operation: 'base:row:reordered',
      rowId,
      position,
      requestId: requestId ?? null,
    });
  }

  // Views CRUD
  async createView(dto: CreateViewDto, userId: string, workspaceId: string) {
    const id = randomUUID();

    const lastView = await this.db
      .selectFrom('baseViews')
      .select('position')
      .where('pageId', '=', dto.pageId)
      .orderBy('position desc')
      .executeTakeFirst();

    const position = getNextPosition(lastView?.position);

    const view = await executeTx(this.db, async (trx) => {
      const inserted = await trx
        .insertInto('baseViews')
        .values({
          id,
          pageId: dto.pageId,
          name: dto.name,
          type: dto.type || 'table',
          position,
          config: toJsonb(dto.config),
          workspaceId,
          creatorId: userId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.bumpSchemaVersion(trx, dto.pageId, workspaceId);
      return inserted;
    });

    const created = {
      ...view,
      config: dto.config || {},
    };
    this.baseWs.emitToBase(dto.pageId, {
      operation: 'base:view:created',
      view: created,
    });
    return created;
  }

  async updateView(dto: UpdateViewDto, workspaceId: string) {
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.type !== undefined) updateData.type = dto.type;
    if (dto.config !== undefined) updateData.config = toJsonb(dto.config);
    if (dto.position !== undefined) updateData.position = dto.position;

    const view = await executeTx(this.db, async (trx) => {
      const updated = await trx
        .updateTable('baseViews')
        .set(updateData)
        .where('id', '=', dto.viewId)
        .where('pageId', '=', dto.pageId)
        .where('workspaceId', '=', workspaceId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.bumpSchemaVersion(trx, dto.pageId, workspaceId);
      return updated;
    });

    const updated = {
      ...view,
      config: dto.config || view.config || {},
    };
    this.baseWs.emitToBase(dto.pageId, {
      operation: 'base:view:updated',
      view: updated,
    });
    return updated;
  }

  async deleteView(viewId: string, pageId: string, workspaceId: string) {
    await executeTx(this.db, async (trx) => {
      await trx
        .deleteFrom('baseViews')
        .where('id', '=', viewId)
        .where('pageId', '=', pageId)
        .where('workspaceId', '=', workspaceId)
        .execute();
      await this.bumpSchemaVersion(trx, pageId, workspaceId);
    });

    this.baseWs.emitToBase(pageId, {
      operation: 'base:view:deleted',
      viewId,
    });
  }

  async listViews(pageId: string, workspaceId: string) {
    const views = await this.db
      .selectFrom('baseViews')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('position asc')
      .execute();

    return views.map((v) => ({
      ...v,
      config: v.config || {},
    }));
  }

  // Export to CSV
  async exportToCsv(pageId: string, workspaceId: string): Promise<string> {
    const properties = await this.db
      .selectFrom('baseProperties')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('position asc')
      .execute();

    // Выгрузка ограничена сверху: без предела один запрос читал всю базу
    // целиком и держал её в памяти. Превышение это явная ошибка, а не
    // молчаливое усечение файла: неполный экспорт хуже отказа.
    const rows = await this.db
      .selectFrom('baseRows')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('position asc')
      .limit(CSV_EXPORT_ROW_LIMIT + 1)
      .execute();

    if (rows.length > CSV_EXPORT_ROW_LIMIT) {
      throw badRequest('error.base.csv_row_limit', {
        limit: CSV_EXPORT_ROW_LIMIT,
      });
    }

    // Build CSV Headers
    const headers = properties.map((p) => p.name);
    let csv = headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(',') + '\n';

    // Build CSV Rows
    for (const row of rows) {
      const cells = row.cells || {};
      const rowValues = properties.map((prop) => {
        const val = cells[prop.id];
        if (val === undefined || val === null) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      });
      csv +=
        rowValues.map((v) => `"${v.replace(/"/g, '""')}"`).join(',') + '\n';
    }

    return csv;
  }
}
