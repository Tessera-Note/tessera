import { SpaceMemberRepo } from './space-member.repo';

/**
 * Вызывающий отбирает тех, кого еще нет, отдельным запросом, но между отбором
 * и вставкой ничего не держит. Два одновременных запроса проходят отбор оба,
 * второй получает от Postgres 23505 и превращается в ответ 500 вместо
 * задуманного «уже добавлен». Условие бытовое: двойное нажатие кнопки, у
 * которой нет заблокированного состояния.
 *
 * На таблице два уникальных ограничения, по пользователю и по группе, и одним
 * `onConflict` они не закрываются: цель у него одна. Поэтому проверяется
 * именно разделение строк по виду участника.
 */
function build() {
  const statements: { rows: any[]; constraint?: string }[] = [];

  const repo: SpaceMemberRepo = Object.create(SpaceMemberRepo.prototype);
  const db: any = {
    // Обе вставки идут одной транзакцией: смешанный набор не должен
    // применяться наполовину.
    transaction: () => ({ execute: (cb: any) => cb(db) }),
    insertInto: () => {
      const statement: { rows: any[]; constraint?: string } = { rows: [] };
      const chain: any = {
        values: (rows: any[]) => {
          statement.rows = rows;
          return chain;
        },
        onConflict: (cb: any) => {
          cb({
            constraint: (name: string) => {
              statement.constraint = name;
              return { doNothing: () => ({}) };
            },
          });
          return chain;
        },
        execute: async () => {
          statements.push(statement);
          return [];
        },
      };
      return chain;
    },
  };
  (repo as any).db = db;

  return { repo, statements };
}

const USER_ROW = { spaceId: 'sp-1', userId: 'u-1', role: 'writer' };
const GROUP_ROW = { spaceId: 'sp-1', groupId: 'g-1', role: 'reader' };

describe('SpaceMemberRepo.insertSpaceMember', () => {
  it('участники по пользователю идут со своим ограничением', async () => {
    const { repo, statements } = build();

    await repo.insertSpaceMember([USER_ROW] as any);

    expect(statements).toHaveLength(1);
    expect(statements[0].constraint).toBe(
      'space_members_space_id_user_id_unique',
    );
    expect(statements[0].rows).toEqual([USER_ROW]);
  });

  it('участники по группе идут со своим ограничением', async () => {
    const { repo, statements } = build();

    await repo.insertSpaceMember([GROUP_ROW] as any);

    expect(statements).toHaveLength(1);
    expect(statements[0].constraint).toBe(
      'space_members_space_id_group_id_unique',
    );
  });

  /** Одним запросом их не вставить: у каждого ограничения своя цель. */
  it('смешанный набор разделяется на два запроса', async () => {
    const { repo, statements } = build();

    await repo.insertSpaceMember([USER_ROW, GROUP_ROW] as any);

    expect(statements.map((s) => s.constraint)).toEqual([
      'space_members_space_id_user_id_unique',
      'space_members_space_id_group_id_unique',
    ]);
    expect(statements[0].rows).toEqual([USER_ROW]);
    expect(statements[1].rows).toEqual([GROUP_ROW]);
  });

  it('одиночная запись принимается наравне со списком', async () => {
    const { repo, statements } = build();

    await repo.insertSpaceMember(USER_ROW as any);

    expect(statements[0].rows).toEqual([USER_ROW]);
  });

  it('пустой набор не порождает запросов', async () => {
    const { repo, statements } = build();

    await repo.insertSpaceMember([] as any);

    expect(statements).toEqual([]);
  });
});

/**
 * Разбиение обязано быть полным: строка без обоих идентификаторов должна
 * дойти до базы и упереться в проверочное ограничение таблицы, как упиралась
 * раньше, а не исчезнуть молча.
 */
describe('SpaceMemberRepo.insertSpaceMember, полнота разбиения', () => {
  it('строка без обоих идентификаторов не теряется', async () => {
    const { repo, statements } = build();

    await repo.insertSpaceMember([{ spaceId: 'sp-1' }] as any);

    expect(statements).toHaveLength(1);
    expect(statements[0].rows).toEqual([{ spaceId: 'sp-1' }]);
  });

  it('обе вставки идут одной транзакцией', async () => {
    const { repo, statements } = build();

    await repo.insertSpaceMember([USER_ROW, GROUP_ROW] as any);

    expect(statements).toHaveLength(2);
  });
});
