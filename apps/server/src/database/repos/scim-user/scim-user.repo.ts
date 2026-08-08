import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { KyselyTransaction } from '@tessera/db/types/kysely.types';
import { UpdatableUser } from '@tessera/db/types/entity.types';

/**
 * Поля, которые протоколу разрешено менять.
 *
 * Узко намеренно: `UpdatableUser` разрешает записать `workspaceId`, `role`,
 * `password` и `deletedAt`, а условие `where` защищает выбор строки, но не
 * запрещает перенести ее в чужое пространство значением из тела запроса.
 */
export type ScimUserUpdate = Pick<
  UpdatableUser,
  'email' | 'name' | 'scimExternalId' | 'deactivatedAt' | 'lastLoginAt'
>;
import { dbOrTx } from '@tessera/db/utils';

/**
 * Представление пользователей для протокола SCIM.
 *
 * Отдельно от `UserRepo` намеренно: у SCIM свой набор полей, своя выборка
 * с `scim_external_id` и своя постраничность по номеру записи, а не по
 * курсору. Смешивать это с основным репозиторием значило бы тащить
 * протокольные особенности в код, который ими не пользуется.
 */
@Injectable()
export class ScimUserRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  private base(workspaceId: string) {
    return this.db
      .selectFrom('users')
      .select([
        'id',
        'name',
        'email',
        'role',
        'scimExternalId',
        'deactivatedAt',
        'createdAt',
        'updatedAt',
      ])
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);
  }

  findById(id: string, workspaceId: string) {
    return this.base(workspaceId).where('id', '=', id).executeTakeFirst();
  }

  /**
   * Поиск по почте регистронезависим, как в `UserRepo.findByEmail`.
   * Уникальное ограничение на колонке построено по сырому значению, и
   * точное сравнение не нашло бы участника, заведенного как `Petrov@…`.
   * Каталог тогда завел бы второго с тем же адресом в другом регистре.
   */
  findByEmail(email: string, workspaceId: string) {
    return this.base(workspaceId)
      .where(sql`LOWER(email)`, '=', sql`LOWER(${email})`)
      .executeTakeFirst();
  }

  findByExternalId(externalId: string, workspaceId: string) {
    return this.base(workspaceId)
      .where('scimExternalId', '=', externalId)
      .executeTakeFirst();
  }

  /**
   * Список с постраничностью по номеру записи.
   *
   * SCIM нумерует записи с единицы, а не с нуля: `startIndex` в спецификации
   * начинается с 1, и смещение считается от него.
   */
  async list(
    workspaceId: string,
    opts: { startIndex: number; count: number; email?: string; externalId?: string },
  ) {
    let query = this.base(workspaceId);
    let countQuery = this.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);

    // Условие ставится по **наличию** ключа, а не по истинности значения.
    // `userName eq ""` это законный фильтр, которому не соответствует никто;
    // при проверке на истинность пустая строка отбрасывалась бы, и запрос
    // одной записи возвращал бы весь каталог.
    if (opts.email !== undefined) {
      const value = sql`LOWER(${opts.email})`;
      query = query.where(sql`LOWER(email)`, '=', value);
      countQuery = countQuery.where(sql`LOWER(email)`, '=', value);
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

  update(
    id: string,
    workspaceId: string,
    values: ScimUserUpdate,
    trx?: KyselyTransaction,
  ) {
    return dbOrTx(this.db, trx)
      .updateTable('users')
      .set({ ...values, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }
}
