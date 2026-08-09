import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Workspace } from '@tessera/db/types/entity.types';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { executeTx } from '@tessera/db/utils';
import { ScimGroupRepo } from '@tessera/db/repos/scim-group/scim-group.repo';
import { GroupRepo } from '@tessera/db/repos/group/group.repo';
import { GroupService } from '../../../core/group/services/group.service';
import { GroupUserService } from '../../../core/group/services/group-user.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import {
  AuditEvent,
  AuditEventType,
  AuditResource,
} from '../../../common/events/audit-events';
import {
  parseScimGroupFilter,
  ScimGroupFilter,
  UnsupportedScimFilterError,
} from '../scim-filter.util';
import { ScimException } from '../scim.exception';
import {
  SCIM_BASE_PATH,
  SCIM_DEFAULT_COUNT,
  SCIM_MAX_RESULTS,
  SCIM_SCHEMAS,
} from '../scim.constants';
import { ScimTokenContext } from './scim-user.service';
/**
 * Патч в `patches/` правит только сборку CommonJS, а сервер собирается в
 * commonjs, поэтому обычный импорт резолвит именно пропатченный вариант.
 */
import * as scimmy from 'scimmy';
import { badRequest } from '../../../common/errors/app-error';

/**
 * Строка группы и строка участника выводятся из самого репозитория, а не
 * описываются здесь заново: при удалении поля из выборки расхождение
 * поймает компилятор, а не провайдер, получивший `undefined` в ответе.
 */
type GroupRow = NonNullable<Awaited<ReturnType<ScimGroupRepo['findById']>>>;
type MemberRow = Awaited<ReturnType<ScimGroupRepo['membersOf']>>[number];

@Injectable()
export class ScimGroupService {
  private readonly logger = new Logger(ScimGroupService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly scimGroupRepo: ScimGroupRepo,
    private readonly groupRepo: GroupRepo,
    private readonly groupService: GroupService,
    private readonly groupUserService: GroupUserService,
    private readonly environmentService: EnvironmentService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  private location(id: string, resource: 'Groups' | 'Users'): string {
    return `${this.environmentService.getAppUrl()}/api/${SCIM_BASE_PATH}/${resource}/${id}`;
  }

  private toResource(row: GroupRow, members?: MemberRow[]) {
    const resource: Record<string, unknown> = {
      schemas: [SCIM_SCHEMAS.GROUP],
      id: row.id,
      externalId: row.scimExternalId ?? undefined,
      displayName: row.name,
      meta: {
        resourceType: 'Group',
        created: row.createdAt,
        lastModified: row.updatedAt,
        location: this.location(row.id, 'Groups'),
      },
    };

    if (members) {
      resource.members = members.map((member) => ({
        value: member.userId,
        display: member.name ?? member.email,
        type: 'User',
        $ref: this.location(member.userId, 'Users'),
      }));
    }

    return resource;
  }

  private async withMembers(rows: GroupRow[], workspace: Workspace) {
    const members = await this.scimGroupRepo.membersOf(
      rows.map((row) => row.id),
      workspace.id,
    );

    return rows.map((row) =>
      this.toResource(
        row,
        members.filter((member) => member.groupId === row.id),
      ),
    );
  }

  async find(id: string, workspace: Workspace, excludedAttributes?: string) {
    const row = await this.require(id, workspace);

    if (this.excludesMembers(excludedAttributes)) return this.toResource(row);
    return (await this.withMembers([row], workspace))[0];
  }

  async list(
    workspace: Workspace,
    query: {
      filter?: string;
      startIndex?: string;
      count?: string;
      excludedAttributes?: string;
    },
  ) {
    const startIndex = Math.max(1, Number(query.startIndex) || 1);
    // `count=0` это законный запрос одного счетчика, а `count=` без значения
    // означает «не задано». `Number('')` дает ноль, и без явной проверки
    // пустой параметр отдавал бы пустую страницу при ненулевом totalResults.
    const raw = (query.count ?? '').trim();
    const requested = Number(raw);
    const count = Math.min(
      SCIM_MAX_RESULTS,
      raw !== '' && Number.isFinite(requested)
        ? Math.max(0, requested)
        : SCIM_DEFAULT_COUNT,
    );

    let filter: ScimGroupFilter;
    try {
      filter = parseScimGroupFilter(query.filter);
    } catch (err) {
      if (err instanceof UnsupportedScimFilterError) {
        throw new ScimException(
          HttpStatus.BAD_REQUEST,
          err.message,
          'invalidFilter',
        );
      }
      throw err;
    }

    const { items, total } = await this.scimGroupRepo.list(workspace.id, {
      startIndex,
      count,
      displayName: filter.displayName,
      externalId: filter.externalId,
    });

    const excludeMembers = this.excludesMembers(query.excludedAttributes);

    return {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: total,
      startIndex,
      itemsPerPage: items.length,
      Resources: excludeMembers
        ? items.map((row) => this.toResource(row))
        : await this.withMembers(items, workspace),
    };
  }

  /**
   * Завести группу по данным каталога.
   *
   * Совпадение имени с существующей группой дает **отказ**, а не присвоение,
   * в отличие от одноименного случая у пользователей. Обоснование в сводке к
   * задаче; коротко: у человека совпадение адреса означает того же человека,
   * а у группы имя это ярлык, а не личность, и присвоение привело бы к тому,
   * что первый же цикл синхронизации привел бы состав ручной группы к
   * составу каталога и выкинул бы оттуда людей вместе с их доступом к
   * пространствам.
   */
  async create(
    payload: any,
    workspace: Workspace,
    token: ScimTokenContext | null = null,
  ) {
    const displayName = this.requireDisplayName(payload);
    const externalId = payload.externalId ?? null;

    const existing = await this.groupRepo.findByName(displayName, workspace.id);
    if (existing) {
      throw new ConflictException(
        `Group with displayName ${displayName} already exists. ` +
          'Rename or delete it before provisioning a group with this name',
      );
    }

    if (externalId) {
      await this.assertExternalIdFree(externalId, null, workspace);
    }

    const memberIds = await this.resolveMembers(payload.members, workspace);

    const created = await executeTx(this.db, async (trx) => {
      const group = await this.groupRepo.insertGroup(
        {
          name: displayName,
          // Описание протоколом не управляется: в схеме Group по RFC 7643
          // такого атрибута нет, он объявлен только у нас в базе.
          description: null,
          // Группой по умолчанию каталог распоряжаться не может: она одна на
          // пространство и заводится вместе с ним.
          isDefault: false,
          // Признак существует именно для этого случая: группа заведена
          // каталогом, а не человеком.
          isExternal: true,
          scimExternalId: externalId,
          // Автора-человека нет, колонка это допускает.
          creatorId: null,
          workspaceId: workspace.id,
        },
        trx,
      );

      // Состав добавляется в той же транзакции, что и сама группа: иначе
      // сбой на середине оставил бы группу без части состава, а провайдер
      // получил бы 500 и повторил создание уже занятого имени.
      await this.groupUserService.addUsersToGroupBatch(
        memberIds,
        group.id,
        workspace.id,
        trx,
      );

      return group;
    });

    this.logger.log(`Каталог завел группу ${created.id}`);
    this.audit(AuditEvent.GROUP_CREATED, created.id, workspace, token, {
      displayName,
      externalId,
      members: memberIds.length,
    });

    return this.find(created.id, workspace);
  }

  /**
   * Полная замена.
   *
   * Отсутствующий в теле `externalId` сохраняется по той же причине, что и
   * у пользователя: это единственная связь записи с каталогом. Описание
   * группы протоколом не управляется и переживает замену: атрибута с таким
   * смыслом в схеме Group по RFC 7643 нет.
   */
  async replace(
    id: string,
    payload: any,
    workspace: Workspace,
    token: ScimTokenContext | null = null,
  ) {
    const row = await this.require(id, workspace);
    this.assertManagedByDirectory(row);

    const displayName = this.requireDisplayName(payload);
    const externalId = payload.externalId ?? row.scimExternalId ?? null;

    await this.applyChanges(row, workspace, token, {
      displayName,
      externalId,
      // Замена без ключа `members` означает пустой состав: это буквальная
      // семантика PUT, и провайдеры на нее рассчитывают.
      members: await this.resolveMembers(payload.members ?? [], workspace),
    });

    return this.find(id, workspace);
  }

  /**
   * Частичное изменение.
   *
   * Разбор операций отдан библиотеке, но решение «трогали ли состав» берется
   * из **самих операций**, а не из результата: пустой список членов
   * сериализуется как отсутствие ключа `members`, и по результату «состав
   * очищен» неотличимо от «состав не передавали». Ошибка в любую сторону
   * стоит доступа: в первом случае последний участник никогда не удалится,
   * во втором любое переименование обнулит состав.
   */
  async patch(
    id: string,
    payload: any,
    workspace: Workspace,
    token: ScimTokenContext | null = null,
  ) {
    const row = await this.require(id, workspace);
    this.assertManagedByDirectory(row);

    const current = await this.scimGroupRepo.membersOf([id], workspace.id);
    const before = new scimmy.Schemas.Group(
      this.toResource(row, current) as any,
      'out',
    );

    let patched: any;
    try {
      const message = new scimmy.Messages.PatchOp(payload);
      patched = await message.apply(before, async (result: any) => result);
    } catch (err: any) {
      throw new ScimException(
        HttpStatus.BAD_REQUEST,
        err?.message ? String(err.message) : 'Invalid PatchOp request',
        typeof err?.scimType === 'string' ? err.scimType : 'invalidSyntax',
      );
    }

    // `apply` возвращает undefined, когда ничего не изменилось. Это штатный
    // сигнал, а не ошибка: провайдеры повторяют патч при сбое сети.
    if (!patched) return this.find(id, workspace);

    const touchesMembers = this.touchesMembers(payload);

    // Проверка та же, что на других путях. Библиотека считает обязательный
    // атрибут заданным, если он не `null` и не `undefined`, поэтому пустая
    // строка через нее проходит, а колонка `groups.name` пустую строку
    // допускает: без этой проверки группа осталась бы без имени.
    const displayName =
      patched.displayName === undefined
        ? row.name
        : this.requireDisplayName({ displayName: patched.displayName });

    await this.applyChanges(row, workspace, token, {
      displayName,
      externalId: patched.externalId ?? row.scimExternalId ?? null,
      members: touchesMembers
        ? await this.resolveMembers(patched.members ?? [], workspace)
        : null,
    });

    return this.find(id, workspace);
  }

  /**
   * Удаление группы.
   *
   * Жесткое, как и на ручном пути: мягкого удаления групп в приложении нет,
   * колонка `groups.deleted_at` не заполняется ничем и не участвует ни в
   * одном запросе и ни в одном из двух уникальных индексов. Ввести его ради
   * протокола значило бы поменять семантику всей модели групп, дописать
   * условие в шесть мест раскрытия групп в правах и пересобрать индексы
   * миграцией.
   *
   * Каскад `ON DELETE CASCADE` уносит `group_users`, `space_members` и
   * `page_permissions` этой группы, а `GroupService.deleteGroup` в той же
   * транзакции чистит наблюдателей и избранное у тех, кто потерял доступ.
   */
  async remove(id: string, workspace: Workspace) {
    const row = await this.require(id, workspace);
    this.assertManagedByDirectory(row);

    await this.groupService.deleteGroup(id, workspace.id, {
      fromDirectory: true,
    });

    // Своего события здесь нет: `GroupService.deleteGroup` пишет
    // `GROUP_DELETED` сам, и вторая запись означала бы в журнале два
    // удаления одной группы. Принадлежность действия каталогу видна по
    // `actor_type = api_key`, который ставит `ScimAuthGuard`.
    this.logger.log(`Каталог удалил группу ${id}`);
  }

  /** Общая часть замены и частичного изменения. */
  private async applyChanges(
    row: GroupRow,
    workspace: Workspace,
    token: ScimTokenContext | null,
    values: {
      displayName: string;
      externalId: string | null;
      /** `null` означает «состав не трогали». */
      members: string[] | null;
    },
  ): Promise<void> {
    if (values.displayName.toLowerCase() !== row.name.toLowerCase()) {
      const clash = await this.groupRepo.findByName(
        values.displayName,
        workspace.id,
      );
      // Сравнение по идентификатору, а не по имени: имя уникально без учета
      // регистра, и сравнение строк отклонило бы смену регистра собственного
      // имени как занятое.
      if (clash && clash.id !== row.id) {
        throw new ConflictException(
          `Group with displayName ${values.displayName} already exists`,
        );
      }
    }

    if (values.externalId && values.externalId !== row.scimExternalId) {
      await this.assertExternalIdFree(values.externalId, row.id, workspace);
    }

    const renamed = values.displayName !== row.name;
    const relinked = values.externalId !== row.scimExternalId;

    if (renamed || relinked) {
      // Описание не перечислено сознательно: атрибута с таким смыслом в
      // схеме Group по RFC 7643 нет, каталог его не присылает, и запись из
      // тела запроса стерла бы описание, заданное человеком в интерфейсе.
      const result = await this.scimGroupRepo.update(row.id, workspace.id, {
        name: values.displayName,
        scimExternalId: values.externalId,
      });

      // Строка читалась до записи. Если ее удалили между чтением и записью,
      // обновлено ноль строк, и отвечать успехом на несделанное нельзя.
      if (Number(result?.numUpdatedRows ?? 0) === 0) {
        throw new NotFoundException(`Group ${row.id} not found`);
      }
    }

    const membersChanged = values.members
      ? await this.syncMembers(row, values.members, workspace, token)
      : false;

    // Событие пишется после применения и только при реальном изменении.
    // Идемпотентная замена приходит на каждом цикле синхронизации, и запись
    // о несостоявшемся изменении засоряла бы журнал ровно так же, как
    // повторное добавление уже состоящих участников. Ручной путь поступает
    // так же, через `diffAuditTrackedFields`.
    if (renamed || relinked || membersChanged) {
      this.audit(AuditEvent.GROUP_UPDATED, row.id, workspace, token, {
        displayName: values.displayName,
        renamed,
        membersChanged,
      });
    }
  }

  /**
   * Привести состав группы к присланному.
   *
   * Считается разница, а не переливается весь список: повторная вставка уже
   * состоящих участников гасится уникальным ограничением, но событие
   * `GROUP_MEMBER_ADDED` при этом все равно пишется, и журнал засорялся бы
   * несуществующими событиями на каждом цикле синхронизации.
   */
  private async syncMembers(
    row: GroupRow,
    desired: string[],
    workspace: Workspace,
    token: ScimTokenContext | null = null,
  ): Promise<boolean> {
    const current = await this.scimGroupRepo.membersOf([row.id], workspace.id);
    const currentIds = new Set(current.map((member) => member.userId));
    const desiredIds = new Set(desired);

    const toAdd = desired.filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));

    if (toAdd.length > 0) {
      await this.groupUserService.addUsersToGroupBatch(
        toAdd,
        row.id,
        workspace.id,
      );
    }

    for (const userId of toRemove) {
      // Исключение идет через сервис приложения, а не прямым удалением
      // строки: он же чистит наблюдателей и избранное у тех, кто потерял
      // доступ к пространствам, которые давала группа.
      await this.groupUserService.removeUserFromGroup(
        userId,
        row.id,
        workspace.id,
      );

      await this.warnAboutRetainedAccess(userId, row, workspace, token);
    }

    return toAdd.length > 0 || toRemove.length > 0;
  }

  /**
   * Отметить расхождение, если исключенный сохранил прямой доступ.
   *
   * Каталог, снявший человека с группы, считает доступ отозванным. Прямая
   * запись `space_members` продолжает действовать, и роль лишь падает до
   * прямой, если групповая была выше. Трогать прямые записи отсюда нельзя:
   * их выдал администратор вручную, каталог о них не знает и никогда их не
   * выдавал. Но и молча оставлять расхождение нельзя, поэтому оно попадает
   * и в журнал сервера, и в журнал аудита: лог читают при разборе
   * происшествия, а журнал аудита смотрят, когда выясняют, кто и когда
   * получил доступ.
   */
  private async warnAboutRetainedAccess(
    userId: string,
    row: GroupRow,
    workspace: Workspace,
    token: ScimTokenContext | null,
  ): Promise<void> {
    const spaceIds = await this.scimGroupRepo.spacesWithDirectAccess(
      userId,
      row.id,
    );

    if (spaceIds.length === 0) return;

    this.logger.warn(
      `Участник ${userId} исключен каталогом из группы ${row.id}, но сохранил ` +
        `прямой доступ к пространствам: ${spaceIds.join(', ')}. ` +
        'Прямые доступы выданы вручную и каталогом не управляются.',
    );

    this.audit(
      AuditEvent.GROUP_DIRECT_ACCESS_RETAINED,
      row.id,
      workspace,
      token,
      { userId, spaceIds },
    );
  }

  /**
   * Превратить `members` из тела запроса в идентификаторы участников.
   *
   * Неизвестный идентификатор дает отказ, а не пропускается. Штатный
   * `addUsersToGroupBatch` молча отбрасывает чужие и несуществующие
   * идентификаторы и возвращает успех, то есть каталог считал бы участника
   * добавленным, а его бы не было. Цена отказа в том, что вся операция
   * падает из-за одного лишнего идентификатора, и это правильная цена:
   * провайдеру надо сказать, что его данные разошлись с нашими.
   */
  private async resolveMembers(
    members: unknown,
    workspace: Workspace,
  ): Promise<string[]> {
    if (members === undefined || members === null) return [];

    if (!Array.isArray(members)) {
      throw new ScimException(
        HttpStatus.BAD_REQUEST,
        'members must be an array',
        'invalidValue',
      );
    }

    const ids: string[] = [];
    for (const member of members) {
      const value = typeof member === 'string' ? member : member?.value;
      if (typeof value !== 'string' || !value) {
        throw new ScimException(
          HttpStatus.BAD_REQUEST,
          'Every member must carry a value attribute',
          'invalidValue',
        );
      }
      if (!ids.includes(value)) ids.push(value);
    }

    const existing = await this.scimGroupRepo.existingUserIds(
      ids,
      workspace.id,
    );
    const missing = ids.filter((id) => !existing.has(id));

    if (missing.length > 0) {
      throw new ScimException(
        HttpStatus.BAD_REQUEST,
        `Unknown members: ${missing.join(', ')}`,
        'invalidValue',
      );
    }

    return ids;
  }

  /**
   * Трогает ли патч состав.
   *
   * Смотрим на операции, а не на результат: пустой состав в результате
   * неотличим от непереданного.
   */
  private touchesMembers(payload: any): boolean {
    const operations = Array.isArray(payload?.Operations)
      ? payload.Operations
      : [];

    return operations.some((operation: any) => {
      const path = operation?.path;
      if (typeof path === 'string') {
        return path.trim().toLowerCase().startsWith('members');
      }
      // Операция без пути применяет значение целиком.
      return (
        operation?.value &&
        typeof operation.value === 'object' &&
        'members' in operation.value
      );
    });
  }

  private async require(id: string, workspace: Workspace): Promise<GroupRow> {
    const row = await this.scimGroupRepo.findById(id, workspace.id);
    if (!row) throw new NotFoundException(`Group ${id} not found`);
    return row;
  }

  /**
   * Каталог распоряжается только тем, что сам завел.
   *
   * Признак принадлежности это `is_external`, а не `scim_external_id`.
   * Атрибут `externalId` по RFC 7643 необязателен, часть провайдеров его не
   * шлет, и завязка на него сделала бы заведенную без него группу навсегда
   * неуправляемой: заведение отвечало бы успехом, а любое последующее
   * изменение отказом с ложной причиной. `is_external` ставится при
   * заведении всегда и заполнялся бэкфиллом миграции SCIM ровно для групп,
   * пришедших из каталога.
   *
   * Группа, заведенная человеком, и системная `Everyone` каталогу не
   * принадлежат. Дать ему право менять и удалять их значило бы разрешить
   * сносить права, которых он не выдавал: удаление группы каскадом уносит
   * ее `space_members` и `page_permissions`, и вернуть их можно только
   * вручную. Читать их он может, иначе отказ по совпадению имени выглядел
   * бы для администратора беспричинным.
   */
  private assertManagedByDirectory(row: GroupRow): void {
    if (row.isDefault) {
      throw new ScimException(
        HttpStatus.BAD_REQUEST,
        'The default group is managed by the application and cannot be changed through SCIM',
        'mutability',
      );
    }

    if (!row.isExternal) {
      throw new ScimException(
        HttpStatus.BAD_REQUEST,
        `Group ${row.name} was created in the application and is not managed by SCIM`,
        'mutability',
      );
    }
  }

  private async assertExternalIdFree(
    externalId: string,
    id: string | null,
    workspace: Workspace,
  ): Promise<void> {
    const other = await this.scimGroupRepo.findByExternalId(
      externalId,
      workspace.id,
    );
    if (other && other.id !== id) {
      throw new ConflictException(
        `Group with externalId ${externalId} already exists`,
      );
    }
  }

  private requireDisplayName(payload: any): string {
    const value = payload?.displayName;
    if (typeof value !== 'string' || !value.trim()) {
      throw badRequest('error.scim.displayname_is_required');
    }
    return value.trim();
  }

  private excludesMembers(excludedAttributes?: string): boolean {
    if (!excludedAttributes) return false;
    return excludedAttributes
      .split(',')
      .map((attribute) => attribute.trim().toLowerCase())
      .includes('members');
  }

  /**
   * Запись в журнал с явным контекстом.
   *
   * Тот же прием, что в `ScimUserService`: обычный `log` берет контекст из
   * CLS, а автора-человека у запросов каталога нет. Ресурс здесь другой,
   * поэтому помощник свой, а не общий: править работающий код ради выноса
   * десяти строк дороже, чем их повторить.
   */
  private audit(
    event: AuditEventType,
    resourceId: string,
    workspace: Workspace,
    token: ScimTokenContext | null,
    metadata: Record<string, unknown> = {},
  ): void {
    void this.auditService.logWithContext(
      {
        event,
        resourceType: AuditResource.GROUP,
        resourceId,
        metadata: {
          source: 'scim',
          tokenId: token?.id ?? null,
          tokenName: token?.name ?? null,
          ...metadata,
        },
      },
      { workspaceId: workspace.id, actorType: 'api_key' },
    );
  }
}
