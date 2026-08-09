import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PagePermissionService } from './page-permission.service';

/**
 * Слой хранения прав страницы был готов целиком, отсутствовала только
 * серверная часть, поэтому клиент звал семь маршрутов и получал 404 на каждый.
 *
 * Проверяется то, что нельзя увидеть по сборке: правило доступа к самому
 * управлению, неотменяемость ограничения без писателя и то, что чтение и
 * правка требуют разного уровня доступа.
 */
const USER = { id: 'u-1' } as any;
const WORKSPACE_ID = 'ws-1';
const PAGE = {
  id: 'p-1',
  slugId: 'slug-1',
  title: 'Страница',
  spaceId: 'sp-1',
  workspaceId: WORKSPACE_ID,
  deletedAt: null,
};

function build(overrides?: {
  page?: any;
  editAccess?: {
    hasAnyRestriction: boolean;
    canAccess: boolean;
    canEdit: boolean;
  };
  pageAccess?: any;
  writers?: number;
  level?: any;
  ancestor?: any;
}) {
  const db = {
    // executeTx открывает транзакцию через db.transaction(); в тесте она
    // сводится к прямому вызову обработчика.
    transaction: () => ({
      execute: (cb: any) => cb('trx'),
    }),
  } as any;

  // Явный `undefined` в наборе значит «записи нет», поэтому проверяется
  // наличие ключа, а не истинность значения.
  const has = (key: string) => !!overrides && key in overrides;

  const pagePermissionRepo: any = {
    findPageAccessByPageId: jest.fn(async () =>
      has('pageAccess') ? overrides.pageAccess : { id: 'pa-1', pageId: 'p-1' },
    ),
    insertPageAccess: jest.fn(async () => ({ id: 'pa-new', pageId: 'p-1' })),
    deletePageAccess: jest.fn(async () => {}),
    insertPagePermissions: jest.fn(async () => {}),
    deletePagePermissionsByUserIds: jest.fn(async () => {}),
    deletePagePermissionsByGroupIds: jest.fn(async () => {}),
    updatePagePermissionRole: jest.fn(async () => {}),
    countWritersByPageAccessId: jest.fn(async () => overrides?.writers ?? 1),
    getPagePermissionsPaginated: jest.fn(async () => ({
      items: [{ id: 'pp-1' }],
      meta: { hasNextPage: false, hasPrevPage: false },
    })),
    canUserEditPage: jest.fn(
      async () =>
        overrides?.editAccess ?? {
          hasAnyRestriction: false,
          canAccess: true,
          canEdit: true,
        },
    ),
    getUserPageAccessLevel: jest.fn(
      async () =>
        overrides?.level ?? {
          hasDirectRestriction: true,
          hasInheritedRestriction: false,
          hasAnyRestriction: true,
          canAccess: true,
          canEdit: true,
        },
    ),
    findRestrictedAncestor: jest.fn(async () => overrides?.ancestor),
  };

  const pageRepo: any = {
    findById: jest.fn(async (id: string) =>
      id === PAGE.id
        ? has('page')
          ? overrides.page
          : PAGE
        : { ...PAGE, id, slugId: 'slug-anc', title: 'Родитель' },
    ),
  };

  const wsService: any = {
    invalidateSpaceRestrictionCache: jest.fn(async () => {}),
  };

  const service = new PagePermissionService(
    db,
    pagePermissionRepo,
    pageRepo,
    wsService,
  );

  return { service, pagePermissionRepo, pageRepo, wsService };
}

describe('PagePermissionService, доступ к самому управлению', () => {
  it('несуществующая страница не найдена', async () => {
    const { service } = build({ page: undefined });

    await expect(
      service.restrict({ pageId: 'p-1' }, USER, WORKSPACE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('удаленная страница не найдена', async () => {
    const { service } = build({ page: { ...PAGE, deletedAt: new Date() } });

    await expect(
      service.restrict({ pageId: 'p-1' }, USER, WORKSPACE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * Идентификатор страницы приходит из тела запроса, а рабочее пространство из
   * токена. Без сверки чужая страница правилась бы по одному лишь знанию
   * идентификатора.
   */
  it('страница чужого рабочего пространства не найдена', async () => {
    const { service } = build({ page: { ...PAGE, workspaceId: 'ws-2' } });

    await expect(
      service.restrict({ pageId: 'p-1' }, USER, WORKSPACE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('без права правки ограничение не задать', async () => {
    const { service } = build({
      editAccess: { hasAnyRestriction: true, canAccess: true, canEdit: false },
    });

    await expect(
      service.restrict({ pageId: 'p-1' }, USER, WORKSPACE_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /** Список участников и сведения об ограничении это чтение, не правка. */
  it('чтение сведений доступно тому, кто видит страницу без права правки', async () => {
    const { service } = build({
      editAccess: { hasAnyRestriction: true, canAccess: true, canEdit: false },
    });

    await expect(
      service.getRestrictionInfo({ pageId: 'p-1' }, USER, WORKSPACE_ID),
    ).resolves.toMatchObject({ userAccess: { canView: true } });
  });

  it('не видящему страницу не показать и участников', async () => {
    const { service } = build({
      editAccess: { hasAnyRestriction: true, canAccess: false, canEdit: false },
    });

    await expect(
      service.getPermissions({ pageId: 'p-1' }, {} as any, USER, WORKSPACE_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PagePermissionService.restrict', () => {
  /**
   * Иначе первым же действием человек закрыл бы страницу от самого себя:
   * после появления ограничения доступ дают только записи прав, а их еще нет.
   */
  it('ограничивший сразу получает право правки', async () => {
    const { service, pagePermissionRepo } = build({ pageAccess: undefined });

    await service.restrict({ pageId: 'p-1' }, USER, WORKSPACE_ID);

    expect(pagePermissionRepo.insertPagePermissions).toHaveBeenCalledWith(
      [{ pageAccessId: 'pa-new', userId: 'u-1', role: 'writer' }],
      'trx',
    );
  });

  it('повторное ограничение не создает второе и не трогает права', async () => {
    const { service, pagePermissionRepo } = build();

    await service.restrict({ pageId: 'p-1' }, USER, WORKSPACE_ID);

    expect(pagePermissionRepo.insertPageAccess).not.toHaveBeenCalled();
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  it('снятие ограничения удаляет запись доступа', async () => {
    const { service, pagePermissionRepo, wsService } = build();

    await service.unrestrict({ pageId: 'p-1' }, USER, WORKSPACE_ID);

    expect(pagePermissionRepo.deletePageAccess).toHaveBeenCalledWith('p-1');
    expect(wsService.invalidateSpaceRestrictionCache).toHaveBeenCalledWith(
      'sp-1',
    );
  });
});

describe('PagePermissionService, выдача и снятие прав', () => {
  it('без адресатов выдача отклоняется', async () => {
    const { service } = build();

    await expect(
      service.addPermission(
        { pageId: 'p-1', role: 'reader' },
        USER,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('на неограниченной странице прав не выдать', async () => {
    const { service } = build({ pageAccess: undefined });

    await expect(
      service.addPermission(
        { pageId: 'p-1', role: 'reader', userIds: ['u-2'] },
        USER,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('люди и группы получают право одним запросом', async () => {
    const { service, pagePermissionRepo } = build();

    await service.addPermission(
      { pageId: 'p-1', role: 'reader', userIds: ['u-2'], groupIds: ['g-1'] },
      USER,
      WORKSPACE_ID,
    );

    expect(pagePermissionRepo.insertPagePermissions).toHaveBeenCalledWith(
      [
        { pageAccessId: 'pa-1', userId: 'u-2', role: 'reader' },
        { pageAccessId: 'pa-1', groupId: 'g-1', role: 'reader' },
      ],
      'trx',
    );
  });

  /** Иначе у одного человека накопилось бы несколько строк с разными ролями. */
  it('повторная выдача заменяет прежнюю роль, а не удваивает запись', async () => {
    const { service, pagePermissionRepo } = build();

    await service.addPermission(
      { pageId: 'p-1', role: 'writer', userIds: ['u-2'] },
      USER,
      WORKSPACE_ID,
    );

    expect(
      pagePermissionRepo.deletePagePermissionsByUserIds,
    ).toHaveBeenCalledWith('pa-1', ['u-2'], 'trx');
  });

  it('без адресатов снятие отклоняется', async () => {
    const { service } = build();

    await expect(
      service.removePermission({ pageId: 'p-1' }, USER, WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * Ограничение без писателя необратимо изнутри: снять его может только тот, у
   * кого есть право правки, а после снятия последнего такого не остается.
   */
  it('снять последнего писателя нельзя', async () => {
    const { service } = build({ writers: 0 });

    await expect(
      service.removePermission(
        { pageId: 'p-1', userIds: ['u-1'] },
        USER,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('снятие при оставшемся писателе проходит', async () => {
    const { service, pagePermissionRepo } = build({ writers: 1 });

    await service.removePermission(
      { pageId: 'p-1', groupIds: ['g-1'] },
      USER,
      WORKSPACE_ID,
    );

    expect(
      pagePermissionRepo.deletePagePermissionsByGroupIds,
    ).toHaveBeenCalledWith('pa-1', ['g-1'], 'trx');
  });
});

describe('PagePermissionService.updateRole', () => {
  it('без человека и без группы роль не сменить', async () => {
    const { service } = build();

    await expect(
      service.updateRole({ pageId: 'p-1', role: 'reader' }, USER, WORKSPACE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('понизить последнего писателя нельзя', async () => {
    const { service } = build({ writers: 0 });

    await expect(
      service.updateRole(
        { pageId: 'p-1', role: 'reader', userId: 'u-1' },
        USER,
        WORKSPACE_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('смена роли доходит до хранилища', async () => {
    const { service, pagePermissionRepo } = build();

    await service.updateRole(
      { pageId: 'p-1', role: 'writer', groupId: 'g-1' },
      USER,
      WORKSPACE_ID,
    );

    expect(pagePermissionRepo.updatePagePermissionRole).toHaveBeenCalledWith(
      'pa-1',
      'writer',
      { userId: undefined, groupId: 'g-1' },
      'trx',
    );
  });
});

describe('PagePermissionService, чтение', () => {
  it('у неограниченной страницы список участников пуст', async () => {
    const { service, pagePermissionRepo } = build({ pageAccess: undefined });

    await expect(
      service.getPermissions({ pageId: 'p-1' }, {} as any, USER, WORKSPACE_ID),
    ).resolves.toEqual({
      items: [],
      meta: { hasNextPage: false, hasPrevPage: false },
    });
    expect(
      pagePermissionRepo.getPagePermissionsPaginated,
    ).not.toHaveBeenCalled();
  });

  it('у ограниченной страницы участники читаются постранично', async () => {
    const { service, pagePermissionRepo } = build();

    await service.getPermissions(
      { pageId: 'p-1' },
      { limit: 20 } as any,
      USER,
      WORKSPACE_ID,
    );

    expect(pagePermissionRepo.getPagePermissionsPaginated).toHaveBeenCalledWith(
      'pa-1',
      { limit: 20 },
    );
  });

  /**
   * Предок известен по идентификатору, а окну нужны название и адрес, иначе
   * человек не поймет, откуда ограничение пришло и куда идти его менять.
   */
  it('унаследованное ограничение показывает источник', async () => {
    const { service } = build({
      level: {
        hasDirectRestriction: false,
        hasInheritedRestriction: true,
        hasAnyRestriction: true,
        canAccess: true,
        canEdit: false,
      },
      ancestor: {
        pageAccessId: 'pa-9',
        pageId: 'p-anc',
        accessLevel: 'reader',
        depth: 2,
      },
      pageAccess: undefined,
    });

    await expect(
      service.getRestrictionInfo({ pageId: 'p-1' }, USER, WORKSPACE_ID),
    ).resolves.toMatchObject({
      restrictionId: undefined,
      hasDirectRestriction: false,
      hasInheritedRestriction: true,
      inheritedFrom: { id: 'p-anc', slugId: 'slug-anc', title: 'Родитель' },
      userAccess: { canView: true, canEdit: false, canManage: false },
    });
  });

  it('без унаследованного ограничения источник не запрашивается', async () => {
    const { service, pageRepo } = build();

    const info = await service.getRestrictionInfo(
      { pageId: 'p-1' },
      USER,
      WORKSPACE_ID,
    );

    expect(info.inheritedFrom).toBeUndefined();
    expect(pageRepo.findById).toHaveBeenCalledTimes(1);
  });

  it('распоряжаться ограничением может тот, кто может править', async () => {
    const { service } = build();

    await expect(
      service.getRestrictionInfo({ pageId: 'p-1' }, USER, WORKSPACE_ID),
    ).resolves.toMatchObject({
      restrictionId: 'pa-1',
      userAccess: { canManage: true },
    });
  });
});
