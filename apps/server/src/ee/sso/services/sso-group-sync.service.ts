import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { GroupUserService } from '../../../core/group/services/group-user.service';

/**
 * Состав групп по данным поставщика входа.
 *
 * Включается переключателем `auth_providers.group_sync`, имя утверждения
 * задает `auth_providers.group_claim_name`.
 *
 * ВЛАДЕНИЕ. Синхронизация распоряжается только теми группами, которые явно
 * привязаны к этому провайдеру: `directory_source = 'sso'` и
 * `directory_provider_id` равен его идентификатору. Привязку заводит
 * администратор, синхронизация ее не создает и не снимает.
 *
 * Прежде владение выводилось из совпадения имени группы с именем в
 * утверждении, и это было неверно дважды. Во-первых, оно захватывало группу,
 * которую каталог не заводил, а вместе с бэкфиллом миграции SCIM, пометившего
 * внешними все неумолчальные группы, вычищало людей из групп, которые
 * администратор ведет руками, вместе с доступами, которые те давали.
 * Во-вторых, это был вектор повышения прав: заведя в каталоге группу с именем
 * административной группы вики, в нее можно было попасть.
 *
 * СОПОСТАВЛЕНИЕ идет по ключу каталога `directory_key`, а не по имени группы.
 * Имя в вики администратор меняет свободно, и связь от этого не рвется.
 * Регистр не учитывается: каталоги отдают различительные имена по-разному.
 *
 * Непривязанная группа не трогается вовсе: ни добавления, ни снятия. Молчаливо
 * добавить человека в группу, которую каталог не ведет, значило бы выдать
 * права, которых администратор не выдавал.
 *
 * Группа по умолчанию исключена всегда: в ней состоят все.
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
      await this.apply({
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        providerId: opts.provider.id,
        groupNames,
      });
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
    providerId: string;
    groupNames: string[];
  }): Promise<void> {
    const wanted = new Set(
      opts.groupNames
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    );

    // Берутся только группы, привязанные к этому провайдеру. Прочие
    // синхронизации не принадлежат, и знать о них ей незачем.
    const owned = await this.db
      .selectFrom('groups')
      .select(['id', 'directoryKey'])
      .where('workspaceId', '=', opts.workspaceId)
      .where('isDefault', '=', false)
      .where('deletedAt', 'is', null)
      .where('directorySource', '=', 'sso')
      .where('directoryProviderId', '=', opts.providerId)
      .execute();

    if (owned.length === 0) return;

    const matched = owned.filter(
      (group) =>
        group.directoryKey !== null &&
        wanted.has(group.directoryKey.trim().toLowerCase()),
    );

    const ownedIds = new Set(owned.map((group) => group.id));
    const matchedIds = new Set(matched.map((group) => group.id));

    const current = await this.db
      .selectFrom('groupUsers')
      .select('groupId')
      .where('userId', '=', opts.userId)
      .where('groupId', 'in', [...ownedIds])
      .execute();

    const currentIds = new Set(current.map((row) => row.groupId));

    const toAdd = matched.filter((group) => !currentIds.has(group.id));
    const toRemove = [...currentIds].filter((id) => !matchedIds.has(id));

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

    for (const groupId of toRemove) {
      await this.groupUsers.removeUserFromGroup(
        opts.userId,
        groupId,
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
