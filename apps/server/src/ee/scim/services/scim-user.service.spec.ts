import { ConflictException, NotFoundException } from '@nestjs/common';
import { ScimUserService } from './scim-user.service';
import { ScimException } from '../scim.exception';
import { SCIM_MAX_RESULTS } from '../scim.constants';

const WORKSPACE = { id: 'ws-1' } as any;
const TOKEN = { id: 'tok-1', name: 'Keycloak' };

type Row = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  scimExternalId: string | null;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'u-1',
    name: 'Иван Петров',
    email: 'petrov@tessera.com',
    role: 'member',
    scimExternalId: null,
    deactivatedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

function build(options: { rows?: Row[]; owners?: number } = {}) {
  const rows: Row[] = options.rows ?? [row()];

  const find = (id: string) => rows.find((r) => r.id === id) ?? undefined;

  const scimUserRepo: any = {
    findById: jest.fn(async (id: string) => find(id)),
    // Подделка повторяет семантику базы: поиск по почте регистронезависим,
    // как в `UserRepo.findByEmail`. При точном сравнении тест не заметил бы,
    // что каталог заводит второго участника с тем же адресом.
    findByEmail: jest.fn(async (email: string) =>
      rows.find((r) => r.email.toLowerCase() === email.toLowerCase()),
    ),
    findByExternalId: jest.fn(async (externalId: string) =>
      rows.find((r) => r.scimExternalId === externalId),
    ),
    list: jest.fn(async () => ({ items: rows, total: rows.length })),
    update: jest.fn(async (id: string, _ws: string, values: any) => {
      Object.assign(find(id) as any, values);
      return { numUpdatedRows: BigInt(1) };
    }),
  };

  const userRepo: any = {
    insertUser: jest.fn(async (values: any) => {
      const created = row({
        id: 'u-new',
        name: values.name,
        email: values.email,
        scimExternalId: values.scimExternalId ?? null,
      });
      rows.push(created);
      return created;
    }),
    roleCountByWorkspaceId: jest.fn(async () => options.owners ?? 1),
  };

  const groupUserRepo: any = { addUserToDefaultGroup: jest.fn(async () => {}) };
  const userSessionRepo: any = {
    revokeByUserId: jest.fn(async () => ['session-1']),
  };
  const wsService: any = { disconnectSessions: jest.fn(async () => {}) };
  const workspaceService: any = { addUserToWorkspace: jest.fn(async () => {}) };
  const environmentService: any = {
    getAppUrl: () => 'https://wiki.tessera.com',
  };
  const auditService: any = { logWithContext: jest.fn() };

  // Транзакция здесь не нужна: проверяется порядок вызовов, а не изоляция.
  const db: any = {
    transaction: () => ({ execute: (cb: any) => cb(db) }),
  };

  const service = new ScimUserService(
    db,
    scimUserRepo,
    userRepo,
    groupUserRepo,
    userSessionRepo,
    wsService,
    workspaceService,
    environmentService,
    auditService,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});

  return {
    service,
    rows,
    scimUserRepo,
    userRepo,
    groupUserRepo,
    userSessionRepo,
    wsService,
    workspaceService,
    auditService,
  };
}

describe('ScimUserService, представление', () => {
  it('строка базы отдается в виде ресурса SCIM', async () => {
    const { service } = build();

    const resource: any = await service.find('u-1', WORKSPACE);

    expect(resource.schemas).toEqual([
      'urn:ietf:params:scim:schemas:core:2.0:User',
    ]);
    expect(resource.id).toBe('u-1');
    expect(resource.userName).toBe('petrov@tessera.com');
    expect(resource.emails).toEqual([
      { value: 'petrov@tessera.com', primary: true, type: 'work' },
    ]);
    expect(resource.active).toBe(true);
    expect(resource.meta.location).toBe(
      'https://wiki.tessera.com/api/scim/v2/Users/u-1',
    );
  });

  it('отключенный отдается с active false', async () => {
    const { service } = build({
      rows: [row({ deactivatedAt: new Date('2026-02-01T00:00:00Z') })],
    });

    const resource: any = await service.find('u-1', WORKSPACE);
    expect(resource.active).toBe(false);
  });

  it('несуществующий дает 404', async () => {
    const { service } = build();
    await expect(service.find('нет', WORKSPACE)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ScimUserService, список', () => {
  it('без параметров берется страница по умолчанию с первой записи', async () => {
    const { service, scimUserRepo } = build();

    const result: any = await service.list(WORKSPACE, {});

    expect(scimUserRepo.list).toHaveBeenCalledWith('ws-1', {
      startIndex: 1,
      count: 100,
      email: undefined,
      externalId: undefined,
    });
    expect(result.totalResults).toBe(1);
    expect(result.startIndex).toBe(1);
    expect(result.itemsPerPage).toBe(1);
  });

  // Иначе один запрос выкачивает весь каталог.
  it('запрошенный размер страницы ограничен объявленным пределом', async () => {
    const { service, scimUserRepo } = build();

    await service.list(WORKSPACE, { count: '100000' });

    expect(scimUserRepo.list.mock.calls[0][1].count).toBe(SCIM_MAX_RESULTS);
  });

  it('нулевой размер страницы сохраняется, это запрос одного счетчика', async () => {
    const { service, scimUserRepo } = build();

    await service.list(WORKSPACE, { count: '0' });

    expect(scimUserRepo.list.mock.calls[0][1].count).toBe(0);
  });

  // По RFC 7644 3.4.2.4 отрицательный count это ноль, а не «не задано».
  it('отрицательный размер страницы трактуется как ноль', async () => {
    const { service, scimUserRepo } = build();

    await service.list(WORKSPACE, { count: '-1' });

    expect(scimUserRepo.list.mock.calls[0][1].count).toBe(0);
  });

  /**
   * Пустое значение фильтра обязано дойти до запроса. Если бы условие
   * ставилось по истинности, запрос одной записи вернул бы весь каталог.
   */
  it('пустое значение фильтра доходит до запроса', async () => {
    const { service, scimUserRepo } = build();

    await service.list(WORKSPACE, { filter: 'userName eq ""' });

    expect(scimUserRepo.list.mock.calls[0][1].email).toBe('');
  });

  it('нумерация с единицы, отрицательное значение подтягивается к ней', async () => {
    const { service, scimUserRepo } = build();

    await service.list(WORKSPACE, { startIndex: '-5' });

    expect(scimUserRepo.list.mock.calls[0][1].startIndex).toBe(1);
  });

  it('фильтр по userName доходит до запроса', async () => {
    const { service, scimUserRepo } = build();

    await service.list(WORKSPACE, {
      filter: 'userName eq "petrov@tessera.com"',
    });

    expect(scimUserRepo.list.mock.calls[0][1].email).toBe('petrov@tessera.com');
  });

  it('фильтр по externalId доходит до запроса', async () => {
    const { service, scimUserRepo } = build();

    await service.list(WORKSPACE, { filter: 'externalId eq "ext-9"' });

    expect(scimUserRepo.list.mock.calls[0][1].externalId).toBe('ext-9');
  });

  it('неподдерживаемый фильтр дает 400 с scimType invalidFilter', async () => {
    const { service } = build();

    const error = await service
      .list(WORKSPACE, { filter: 'userName sw "пет"' })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ScimException);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse().scimType).toBe('invalidFilter');
  });
});

describe('ScimUserService, заведение', () => {
  it('нового участника заводит с ролью member и без отметки о входе', async () => {
    const { service, userRepo, workspaceService, groupUserRepo } = build({
      rows: [],
    });

    const resource: any = await service.create(
      {
        userName: 'new@tessera.com',
        externalId: 'ext-1',
        displayName: 'Новый',
      },
      WORKSPACE,
      TOKEN,
    );

    expect(userRepo.insertUser.mock.calls[0][0]).toMatchObject({
      email: 'new@tessera.com',
      name: 'Новый',
      role: 'member',
      workspaceId: 'ws-1',
      scimExternalId: 'ext-1',
    });
    expect(workspaceService.addUserToWorkspace).toHaveBeenCalledWith(
      'u-new',
      'ws-1',
      'member',
      expect.anything(),
    );
    expect(groupUserRepo.addUserToDefaultGroup).toHaveBeenCalled();
    expect(resource.userName).toBe('new@tessera.com');
  });

  it('пароль в ответ не попадает', async () => {
    const { service } = build({ rows: [] });

    const resource: any = await service.create(
      { userName: 'new@tessera.com' },
      WORKSPACE,
      TOKEN,
    );

    expect(JSON.stringify(resource)).not.toContain('password');
  });

  it('адрес приводится к нижнему регистру', async () => {
    const { service, userRepo } = build({ rows: [] });

    await service.create({ userName: 'NEW@Tessera.COM' }, WORKSPACE, TOKEN);

    expect(userRepo.insertUser.mock.calls[0][0].email).toBe('new@tessera.com');
  });

  it('имя собирается из частей, когда displayName не задан', async () => {
    const { service, userRepo } = build({ rows: [] });

    await service.create(
      {
        userName: 'new@tessera.com',
        name: { givenName: 'Иван', familyName: 'Петров' },
      },
      WORKSPACE,
      TOKEN,
    );

    expect(userRepo.insertUser.mock.calls[0][0].name).toBe('Иван Петров');
  });

  it('тело без адреса отвергается', async () => {
    const { service } = build({ rows: [] });

    await expect(service.create({}, WORKSPACE, TOKEN)).rejects.toThrow(
      /userName/,
    );
  });

  it('active false заводит участника сразу отключенным', async () => {
    const { service, rows } = build({ rows: [] });

    const resource: any = await service.create(
      { userName: 'new@tessera.com', active: false },
      WORKSPACE,
      TOKEN,
    );

    expect(resource.active).toBe(false);
    expect(rows[0].deactivatedAt).toBeInstanceOf(Date);
  });

  it('адрес берется из emails, если userName не задан', async () => {
    const { service, userRepo } = build({ rows: [] });

    await service.create(
      { emails: [{ value: 'a@tessera.com', primary: true }] },
      WORKSPACE,
      TOKEN,
    );

    expect(userRepo.insertUser.mock.calls[0][0].email).toBe('a@tessera.com');
  });
});

/**
 * Решение по совпадению адреса. Запись без внешнего идентификатора
 * присваивается каталогу, запись с другим идентификатором дает отказ.
 */
describe('ScimUserService, совпадение адреса с существующим участником', () => {
  it('участник, заведенный обычным путем, присваивается каталогу', async () => {
    const { service, rows, userRepo, auditService } = build({
      rows: [row({ scimExternalId: null })],
    });

    const resource: any = await service.create(
      { userName: 'petrov@tessera.com', externalId: 'ext-7' },
      WORKSPACE,
      TOKEN,
    );

    expect(resource.id).toBe('u-1');
    expect(rows[0].scimExternalId).toBe('ext-7');
    // Второй записи не появилось.
    expect(userRepo.insertUser).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(auditService.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.updated',
        metadata: expect.objectContaining({ adopted: true, source: 'scim' }),
      }),
      { workspaceId: 'ws-1', actorType: 'api_key' },
    );
  });

  it('присвоение возвращает отключенного к работе и пишет событие активации', async () => {
    const { service, rows, auditService } = build({
      rows: [row({ scimExternalId: null, deactivatedAt: new Date() })],
    });

    const resource: any = await service.create(
      { userName: 'petrov@tessera.com', externalId: 'ext-7' },
      WORKSPACE,
      TOKEN,
    );

    expect(resource.active).toBe(true);
    expect(rows[0].deactivatedAt).toBeNull();
    // Тот же переход через замену пишет это событие, расходиться пути не должны.
    expect(auditService.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.activated' }),
      expect.anything(),
    );
  });

  it('присвоение с active false отключает и обрывает сеансы', async () => {
    const { service, rows, userSessionRepo } = build({
      rows: [row({ scimExternalId: null })],
    });

    const resource: any = await service.create(
      { userName: 'petrov@tessera.com', externalId: 'ext-7', active: false },
      WORKSPACE,
      TOKEN,
    );

    expect(resource.active).toBe(false);
    expect(rows[0].deactivatedAt).toBeInstanceOf(Date);
    expect(userSessionRepo.revokeByUserId).toHaveBeenCalled();
  });

  it('присвоение единственного владельца с active false отвергается', async () => {
    const { service, rows } = build({
      rows: [row({ role: 'owner', scimExternalId: null })],
      owners: 1,
    });

    await expect(
      service.create(
        { userName: 'petrov@tessera.com', active: false },
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(ScimException);

    expect(rows[0].deactivatedAt).toBeNull();
  });

  it('повторное заведение под тем же идентификатором не создает дубликат', async () => {
    const { service, userRepo } = build({
      rows: [row({ scimExternalId: 'ext-7' })],
    });

    const resource: any = await service.create(
      { userName: 'petrov@tessera.com', externalId: 'ext-7' },
      WORKSPACE,
      TOKEN,
    );

    expect(resource.id).toBe('u-1');
    expect(userRepo.insertUser).not.toHaveBeenCalled();
  });

  it('чужой внешний идентификатор на том же адресе дает 409', async () => {
    const { service } = build({ rows: [row({ scimExternalId: 'ext-1' })] });

    const error = await service
      .create(
        { userName: 'petrov@tessera.com', externalId: 'ext-2' },
        WORKSPACE,
        TOKEN,
      )
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
  });

  it('занятый внешний идентификатор на другом адресе дает 409', async () => {
    const { service } = build({ rows: [row({ scimExternalId: 'ext-1' })] });

    await expect(
      service.create(
        { userName: 'другой@tessera.com', externalId: 'ext-1' },
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(ConflictException);
  });
});

describe('ScimUserService, регистр адреса', () => {
  /**
   * Уникальное ограничение на колонке построено по сырому значению, поэтому
   * точное сравнение не помешало бы завести второго участника с тем же
   * адресом в другом регистре.
   */
  it('участник, заведенный со смешанным регистром, находится и присваивается', async () => {
    const { service, rows, userRepo } = build({
      rows: [row({ email: 'Petrov@Tessera.com', scimExternalId: null })],
    });

    const resource: any = await service.create(
      { userName: 'petrov@tessera.com', externalId: 'ext-7' },
      WORKSPACE,
      TOKEN,
    );

    expect(resource.id).toBe('u-1');
    expect(userRepo.insertUser).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('замена на чужой адрес в другом регистре дает 409', async () => {
    const { service } = build({
      rows: [row(), row({ id: 'u-2', email: 'Занят@Tessera.com' })],
    });

    await expect(
      service.replace(
        'u-1',
        { userName: 'занят@tessera.com' },
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(ConflictException);
  });
});

describe('ScimUserService, замена', () => {
  it('меняет адрес и имя', async () => {
    const { service, rows } = build();

    await service.replace(
      'u-1',
      { userName: 'ivanov@tessera.com', displayName: 'Иван Иванов' },
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].email).toBe('ivanov@tessera.com');
    expect(rows[0].name).toBe('Иван Иванов');
  });

  /**
   * Внешний идентификатор это единственная связь с каталогом. Очистив ее,
   * сервер потерял бы соответствие, и следующий запрос выглядел бы как
   * новый сотрудник.
   */
  it('отсутствующий в теле externalId сохраняется', async () => {
    const { service, rows } = build({
      rows: [row({ scimExternalId: 'ext-3' })],
    });

    await service.replace(
      'u-1',
      { userName: 'petrov@tessera.com' },
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].scimExternalId).toBe('ext-3');
  });

  it('чужой адрес дает 409', async () => {
    const { service } = build({
      rows: [row(), row({ id: 'u-2', email: 'занят@tessera.com' })],
    });

    await expect(
      service.replace(
        'u-1',
        { userName: 'занят@tessera.com' },
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('чужой внешний идентификатор дает 409', async () => {
    const { service } = build({
      rows: [
        row(),
        row({ id: 'u-2', email: 'b@tessera.com', scimExternalId: 'ext-9' }),
      ],
    });

    await expect(
      service.replace(
        'u-1',
        { userName: 'petrov@tessera.com', externalId: 'ext-9' },
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('несуществующий дает 404', async () => {
    const { service } = build();

    await expect(
      service.replace('нет', { userName: 'a@tessera.com' }, WORKSPACE, TOKEN),
    ).rejects.toThrow(NotFoundException);
  });

  it('active false отключает и обрывает сеансы', async () => {
    const { service, rows, userSessionRepo, wsService } = build();

    await service.replace(
      'u-1',
      { userName: 'petrov@tessera.com', active: false },
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].deactivatedAt).toBeInstanceOf(Date);
    expect(userSessionRepo.revokeByUserId).toHaveBeenCalledWith(
      'u-1',
      'ws-1',
      expect.anything(),
    );
    // Пометка сессий отозванными не разрывает уже открытые сокеты.
    expect(wsService.disconnectSessions).toHaveBeenCalledWith(['session-1']);
  });

  it('active true возвращает отключенного к работе', async () => {
    const { service, rows, auditService } = build({
      rows: [row({ deactivatedAt: new Date() })],
    });

    await service.replace(
      'u-1',
      { userName: 'petrov@tessera.com', active: true },
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].deactivatedAt).toBeNull();
    expect(auditService.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.activated' }),
      expect.anything(),
    );
  });
});

describe('ScimUserService, частичное изменение', () => {
  const patchOp = (operations: any[]) => ({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: operations,
  });

  it('replace active false отключает', async () => {
    const { service, rows, userSessionRepo } = build();

    await service.patch(
      'u-1',
      patchOp([{ op: 'replace', path: 'active', value: false }]),
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].deactivatedAt).toBeInstanceOf(Date);
    expect(userSessionRepo.revokeByUserId).toHaveBeenCalled();
  });

  it('replace active true включает обратно', async () => {
    const { service, rows } = build({
      rows: [row({ deactivatedAt: new Date() })],
    });

    await service.patch(
      'u-1',
      patchOp([{ op: 'replace', path: 'active', value: true }]),
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].deactivatedAt).toBeNull();
  });

  it('изменение имени доходит до базы', async () => {
    const { service, rows } = build();

    await service.patch(
      'u-1',
      patchOp([{ op: 'replace', path: 'displayName', value: 'Петр Иванов' }]),
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].name).toBe('Петр Иванов');
  });

  it('изменение userName доходит до базы', async () => {
    const { service, rows } = build();

    await service.patch(
      'u-1',
      patchOp([
        { op: 'replace', path: 'userName', value: 'Новый@Tessera.com' },
      ]),
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].email).toBe('новый@tessera.com');
  });

  // Без пути значение применяется целиком, это законная форма по RFC 7644.
  it('операция без пути применяется', async () => {
    const { service, rows } = build();

    await service.patch(
      'u-1',
      patchOp([{ op: 'replace', value: { active: false } }]),
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].deactivatedAt).toBeInstanceOf(Date);
  });

  it('не переданные поля остаются прежними', async () => {
    const { service, rows } = build({
      rows: [row({ scimExternalId: 'ext-5' })],
    });

    await service.patch(
      'u-1',
      patchOp([{ op: 'replace', path: 'displayName', value: 'Другое имя' }]),
      WORKSPACE,
      TOKEN,
    );

    expect(rows[0].email).toBe('petrov@tessera.com');
    expect(rows[0].scimExternalId).toBe('ext-5');
  });

  it('негодное тело дает 400 с уточнением причины', async () => {
    const { service } = build();

    const error = await service
      .patch('u-1', { schemas: [], Operations: [] }, WORKSPACE, TOKEN)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ScimException);
    expect(error.getStatus()).toBe(400);
    expect(typeof error.getResponse().scimType).toBe('string');
  });

  it('несуществующий дает 404', async () => {
    const { service } = build();

    await expect(
      service.patch(
        'нет',
        patchOp([{ op: 'replace', path: 'active', value: false }]),
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ScimUserService, удаление означает отключение', () => {
  it('запись остается, ставится отметка отключения, сеансы обрываются', async () => {
    const { service, rows, userSessionRepo, auditService } = build();

    await service.deactivate('u-1', WORKSPACE, TOKEN);

    expect(rows).toHaveLength(1);
    expect(rows[0].deactivatedAt).toBeInstanceOf(Date);
    expect(userSessionRepo.revokeByUserId).toHaveBeenCalled();
    expect(auditService.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.deactivated' }),
      { workspaceId: 'ws-1', actorType: 'api_key' },
    );
  });

  // Провайдер повторяет запрос при сбое сети.
  it('повторное удаление отключенного не ошибка и не переписывает отметку', async () => {
    const first = new Date('2026-03-01T00:00:00Z');
    const { service, rows, userSessionRepo } = build({
      rows: [row({ deactivatedAt: first })],
    });

    await expect(
      service.deactivate('u-1', WORKSPACE, TOKEN),
    ).resolves.toBeUndefined();

    expect(rows[0].deactivatedAt).toBe(first);
    expect(userSessionRepo.revokeByUserId).not.toHaveBeenCalled();
  });

  it('несуществующий дает 404', async () => {
    const { service } = build();

    await expect(service.deactivate('нет', WORKSPACE, TOKEN)).rejects.toThrow(
      NotFoundException,
    );
  });
});

/**
 * Инвариант тот же, что на ручном пути: пространство без владельца чинится
 * только из базы. Запрещенное через интерфейс не должно достигаться через
 * каталог.
 */
describe('ScimUserService, последний владелец', () => {
  it('единственного владельца отключить нельзя', async () => {
    const { service, rows, userSessionRepo } = build({
      rows: [row({ role: 'owner' })],
      owners: 1,
    });

    const error = await service
      .deactivate('u-1', WORKSPACE, TOKEN)
      .catch((e) => e);

    // Совпадения здесь нет, изменение несовместимо с текущим состоянием.
    expect(error).toBeInstanceOf(ScimException);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse().scimType).toBe('mutability');

    expect(rows[0].deactivatedAt).toBeNull();
    expect(userSessionRepo.revokeByUserId).not.toHaveBeenCalled();
  });

  it('владельца можно отключить, когда есть второй', async () => {
    const { service, rows } = build({
      rows: [row({ role: 'owner' })],
      owners: 2,
    });

    await service.deactivate('u-1', WORKSPACE, TOKEN);

    expect(rows[0].deactivatedAt).toBeInstanceOf(Date);
  });

  it('тот же запрет действует через замену', async () => {
    const { service } = build({ rows: [row({ role: 'owner' })], owners: 1 });

    await expect(
      service.replace(
        'u-1',
        { userName: 'petrov@tessera.com', active: false },
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(ScimException);
  });

  it('тот же запрет действует через частичное изменение', async () => {
    const { service } = build({ rows: [row({ role: 'owner' })], owners: 1 });

    await expect(
      service.patch(
        'u-1',
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        },
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(ScimException);
  });

  it('обычного участника запрет не касается', async () => {
    const { service, rows } = build({
      rows: [row({ role: 'member' })],
      owners: 1,
    });

    await service.deactivate('u-1', WORKSPACE, TOKEN);

    expect(rows[0].deactivatedAt).toBeInstanceOf(Date);
  });
});
