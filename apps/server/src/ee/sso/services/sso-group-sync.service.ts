import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { GroupUserService } from '../../../core/group/services/group-user.service';

/**
 * Состав групп по данным поставщика входа.
 *
 * Колонка `auth_providers.group_sync` была заведена давно, но ни один поток
 * входа ее не читал: переключатель из форм убрали, чтобы сохраняемая
 * настройка не обещала поведения, которого нет.
 *
 * Правило сопоставления. Группа поставщика находится по имени среди групп
 * рабочего пространства, регистр не важен. Новых групп синхронизация не
 * создает: имена в каталоге организации бывают служебными и многочисленными,
 * и заводить их все в вики значило бы засорить список групп по одному входу
 * одного человека. Администратор заводит нужные группы сам, и совпадение по
 * имени включает их в синхронизацию.
 *
 * Владение членством. Группа, хоть раз совпавшая по имени, помечается
 * внешней. С этого момента состав в ней ведет каталог: человека, которого
 * каталог больше не числит, синхронизация из такой группы убирает. Группы,
 * не совпавшие ни разу, остаются ручными, и их состав не трогается вовсе.
 * Без этого разделения синхронизация либо не могла бы убирать никого, либо
 * убирала бы людей из групп, которые администратор ведет руками.
 *
 * Группа по умолчанию исключена всегда: в ней состоят все, и каталог не может
 * этого отменить.
 */
@Injectable()
export class SsoGroupSyncService {
  private readonly logger = new Logger(SsoGroupSyncService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly groupUsers: GroupUserService,
  ) {}

  /**
   * Привести состав групп человека к тому, что прислал поставщик.
   *
   * Отказ синхронизации не отменяет входа: человек уже подтвердил себя, и
   * оставлять его снаружи из-за недоступной группы неверно. Расхождение
   * попадает в журнал сервера.
   */
  async sync(opts: {
    userId: string;
    workspaceId: string;
    provider: { id: string; groupSync?: boolean | null };
    groupNames?: string[];
  }): Promise<void> {
    if (!opts.provider?.groupSync) return;

    // Отсутствие списка и пустой список это разные вещи. Пустой список
    // означает, что каталог не числит человека нигде, и членство снимается.
    // Отсутствие означает, что поток входа групп не присылает вовсе, и
    // трактовать это как «нигде не числится» нельзя: включенный переключатель
    // у такого провайдера снял бы человека со всех внешних групп.
    if (!Array.isArray(opts.groupNames)) return;

    const groupNames = opts.groupNames;
    if (!Array.isArray(groupNames)) return;

    try {
      await this.apply({ ...opts, groupNames });
    } catch (err) {
      this.logger.error(
        `Синхронизация групп для ${opts.userId} не удалась: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async apply(opts: {
    userId: string;
    workspaceId: string;
    groupNames: string[];
  }): Promise<void> {
    const wanted = new Set(
      opts.groupNames
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    );

    const groups = await this.db
      .selectFrom('groups')
      .select(['id', 'name', 'isDefault', 'isExternal'])
      .where('workspaceId', '=', opts.workspaceId)
      .execute();

    const matched = groups.filter(
      (group) => !group.isDefault && wanted.has(group.name.toLowerCase()),
    );

    // Совпадение по имени переводит группу под управление каталога. Отметка
    // та же, что ставит SCIM: способ появления группы снаружи разный,
    // а следствие одно, и второй отметки для него заводить незачем.
    const toMark = matched.filter((group) => !group.isExternal);
    if (toMark.length > 0) {
      await this.db
        .updateTable('groups')
        .set({ isExternal: true, updatedAt: new Date() })
        .where(
          'id',
          'in',
          toMark.map((group) => group.id),
        )
        .execute();
    }

    const current = await this.db
      .selectFrom('groupUsers')
      .innerJoin('groups', 'groups.id', 'groupUsers.groupId')
      .select([
        'groupUsers.groupId as groupId',
        'groups.isExternal as isExternal',
      ])
      .where('groupUsers.userId', '=', opts.userId)
      .where('groups.workspaceId', '=', opts.workspaceId)
      .where('groups.isDefault', '=', false)
      .execute();

    const currentIds = new Set(current.map((row) => row.groupId));
    const matchedIds = new Set(matched.map((group) => group.id));

    const toAdd = matched.filter((group) => !currentIds.has(group.id));
    const toRemove = current.filter(
      (row) => row.isExternal && !matchedIds.has(row.groupId),
    );

    // Членство меняется только через сервис групп. Прямая запись в таблицу
    // сохранила бы человеку кеш ролей пространства, комнаты Socket.IO,
    // избранное и подписки на страницы, доступ к которым он уже потерял, не
    // записала бы событие в журнал и обошла бы проверку на то, что
    // пространство не остается без администратора. SCIM ходит тем же путем.
    for (const group of toAdd) {
      await this.groupUsers.addUsersToGroupBatch(
        [opts.userId],
        group.id,
        opts.workspaceId,
      );
    }

    for (const row of toRemove) {
      await this.groupUsers.removeUserFromGroup(
        opts.userId,
        row.groupId,
        opts.workspaceId,
      );
    }

    if (toAdd.length > 0 || toRemove.length > 0) {
      this.logger.debug(
        `Группы ${opts.userId}: добавлено ${toAdd.length}, снято ${toRemove.length}`,
      );
    }
  }
}

/**
 * Достать имена групп из профиля поставщика.
 *
 * Имя утверждения задает администратор: единого стандарта нет, у одного
 * провайдера это `groups`, у другого `roles` или полный URI. Пусто означает
 * `groups`, самое частое значение.
 *
 * Значение приходит и массивом, и одной строкой через запятую, и полным
 * различительным именем LDAP. Все три вида приводятся к простым именам.
 */
export function extractGroupNames(
  profile: Record<string, unknown> | null | undefined,
  claimName?: string | null,
): string[] | undefined {
  if (!profile) return undefined;

  const claim = (claimName ?? '').trim() || 'groups';
  const raw = profile[claim];

  // Отсутствие утверждения и пустое утверждение это разные вещи. Пустое
  // означает, что каталог не числит человека нигде, и членство снимается.
  // Отсутствие означает, что провайдер групп не прислал вовсе, и снимать по
  // этому основанию нельзя: у провайдера без нужной области видимости
  // включенный переключатель вычистил бы человеку все группы каталога.
  if (raw === null || raw === undefined) return undefined;

  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];

  return values
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0)
    .map(commonNameOf);
}

/**
 * Из различительного имени LDAP берется только общее имя.
 *
 * Каталог отдает `CN=Отдел кадров,OU=Groups,DC=example,DC=com`, а в вики
 * группа называется «Отдел кадров». Сравнивать по полному имени значило бы
 * требовать от администратора вписывать различительное имя в название группы.
 */
function commonNameOf(value: string): string {
  const match = /^\s*CN=([^,]+)/i.exec(value);
  return match ? match[1].trim() : value;
}
