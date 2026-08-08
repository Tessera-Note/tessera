import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { UpdatableGroup } from '@tessera/db/types/entity.types';

/**
 * Поля группы, которые протоколу разрешено менять.
 *
 * Узко намеренно: `UpdatableGroup` разрешает записать `workspaceId`,
 * `isDefault` и `deletedAt`, а условие `where` защищает выбор строки, но не
 * запрещает перенести группу в чужое пространство или объявить ее группой
 * по умолчанию значением из тела запроса каталога.
 *
 * `description` сюда не входит: атрибута с таким смыслом в схеме Group по
 * RFC 7643 нет, каталог его не присылает, и запись стерла бы описание,
 * заданное человеком. `isExternal` тоже: он ставится один раз при заведении
 * и служит признаком принадлежности группы каталогу, менять его протокол
 * не должен.
 */
export type ScimGroupUpdate = Pick<UpdatableGroup, 'name' | 'scimExternalId'>;

/**
 * Представление групп для протокола SCIM.
 *
 * Отдельно от `GroupRepo` намеренно, по тем же причинам, что и у
 * `ScimUserRepo`: у протокола своя постраничность по номеру записи, свой
 * поиск по `scim_external_id` и своя выдача состава. Все, что уже умеет
 * `GroupRepo` (поиск по имени без учета регистра, вставка, обновление,
 * удаление), переиспользуется, а не повторяется здесь.
 *
 * Фильтра по `deleted_at` тут нет сознательно: группы удаляются жестко
 * (`GroupRepo.delete` это `deleteFrom`), колонка `groups.deleted_at`
 * существует, но не заполняется ничем. Добавить фильтр значило бы обещать
 * мягкое удаление, которого нет.
 */
@Injectable()
export class ScimGroupRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  private base(workspaceId: string) {
    return this.db
      .selectFrom('groups')
      .select([
        'id',
        'name',
        'description',
        'isDefault',
        'isExternal',
        'scimExternalId',
        'createdAt',
        'updatedAt',
      ])
      .where('workspaceId', '=', workspaceId);
  }

  findById(id: string, workspaceId: string) {
    return this.base(workspaceId).where('id', '=', id).executeTakeFirst();
  }

  findByExternalId(externalId: string, workspaceId: string) {
    return this.base(workspaceId)
      .where('scimExternalId', '=', externalId)
      .executeTakeFirst();
  }

  /**
   * Список с постраничностью по номеру записи.
   *
   * `startIndex` в спецификации начинается с единицы, смещение считается от
   * него.
   *
   * Порядок по **неизменяемому** ключу, как в `ScimUserRepo.list`. Имя
   * менять можно, а постраничность построена на смещении: переименование
   * во время обхода сдвинуло бы позицию группы, и провайдер либо пропустил
   * бы запись, либо увидел ее дважды. Пропущенная запись для многих
   * провайдеров означает «удалена на сервере».
   */
  async list(
    workspaceId: string,
    opts: {
      startIndex: number;
      count: number;
      displayName?: string;
      externalId?: string;
    },
  ) {
    let query = this.base(workspaceId);
    let countQuery = this.db
      .selectFrom('groups')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('workspaceId', '=', workspaceId);

    // Условие ставится по наличию ключа, а не по истинности значения:
    // `displayName eq ""` это законный фильтр, которому не отвечает никто.
    if (opts.displayName !== undefined) {
      const value = sql`LOWER(${opts.displayName})`;
      query = query.where(sql`LOWER(name)`, '=', value);
      countQuery = countQuery.where(sql`LOWER(name)`, '=', value);
    }
    if (opts.externalId !== undefined) {
      query = query.where('scimExternalId', '=', opts.externalId);
      countQuery = countQuery.where('scimExternalId', '=', opts.externalId);
    }

    const [items, total] = await Promise.all([
      query
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .offset(Math.max(0, opts.startIndex - 1))
        .limit(opts.count)
        .execute(),
      countQuery.executeTakeFirst(),
    ]);

    return { items, total: Number(total?.total ?? 0) };
  }

  /**
   * Состав сразу нескольких групп одним запросом.
   *
   * Отдельный запрос на группу превратил бы выдачу страницы в N+1, а список
   * групп провайдер запрашивает на каждом цикле синхронизации.
   *
   * Отключенные участники в состав **входят**. Отключение это состояние
   * пользователя, которое протокол выражает признаком `active` ресурса User,
   * а не выход из группы. Скрыв их здесь, сервер получил бы вечный цикл:
   * каталог видит в своем составе человека, которого нет в ответе, и шлет
   * его добавление на каждой синхронизации.
   *
   * Удаленные не входят: `WorkspaceService.deleteUser` обезличивает строку и
   * снимает все членства, так что их тут и не бывает, а условие стоит на
   * случай, если членство когда-нибудь переживет удаление.
   */
  async membersOf(groupIds: string[], workspaceId: string) {
    if (groupIds.length === 0) return [];

    return this.db
      .selectFrom('groupUsers')
      .innerJoin('users', 'users.id', 'groupUsers.userId')
      .select([
        'groupUsers.groupId',
        'users.id as userId',
        'users.name',
        'users.email',
      ])
      .where('groupUsers.groupId', 'in', groupIds)
      .where('users.workspaceId', '=', workspaceId)
      .where('users.deletedAt', 'is', null)
      .orderBy('users.name', 'asc')
      .execute();
  }

  /**
   * Пространства, где участник сохранил **прямой** доступ, из числа тех,
   * которые давала группа.
   *
   * Нужно для отметки о расхождении: каталог, исключивший человека из
   * группы, считает доступ отозванным, а прямая запись `space_members`
   * продолжает действовать. Молча такое расхождение оставлять нельзя.
   */
  async spacesWithDirectAccess(userId: string, groupId: string) {
    const rows = await this.db
      .selectFrom('spaceMembers as direct')
      .select('direct.spaceId')
      .where('direct.userId', '=', userId)
      .where('direct.spaceId', 'in', (eb) =>
        eb
          .selectFrom('spaceMembers')
          .select('spaceMembers.spaceId')
          .where('spaceMembers.groupId', '=', groupId),
      )
      .execute();

    return rows.map((row) => row.spaceId);
  }

  /**
   * Какие из присланных идентификаторов есть в пространстве.
   *
   * Одним запросом, а не по одному на участника: замена состава крупной
   * группы иначе дала бы столько же последовательных обращений к базе,
   * сколько в ней людей. Тот же довод, что у `membersOf`.
   */
  async existingUserIds(
    ids: string[],
    workspaceId: string,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();

    const rows = await this.db
      .selectFrom('users')
      .select('id')
      .where('id', 'in', ids)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();

    return new Set(rows.map((row) => row.id));
  }

  update(id: string, workspaceId: string, values: ScimGroupUpdate) {
    return this.db
      .updateTable('groups')
      .set({ ...values, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }
}
