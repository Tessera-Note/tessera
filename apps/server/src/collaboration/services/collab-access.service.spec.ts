import { CollabAccessService } from './collab-access.service';

const PAGE = { id: 'page-1', spaceId: 'space-1', deletedAt: null } as const;

function build(
  options: {
    roles?: any;
    restriction?: {
      hasAnyRestriction: boolean;
      canAccess: boolean;
      canEdit: boolean;
    };
  } = {},
) {
  const spaceMemberRepo: any = {
    getUserSpaceRoles: jest.fn(async () =>
      'roles' in options ? options.roles : [{ userId: 'u-1', role: 'writer' }],
    ),
  };
  const pagePermissionRepo: any = {
    canUserEditPage: jest.fn(
      async () =>
        options.restriction ?? {
          hasAnyRestriction: false,
          canAccess: true,
          canEdit: true,
        },
    ),
  };

  return {
    service: new CollabAccessService(spaceMemberRepo, pagePermissionRepo),
    spaceMemberRepo,
    pagePermissionRepo,
  };
}

describe('CollabAccessService, доступ по роли в space', () => {
  it('writer получает право правки', async () => {
    const { service } = build();

    await expect(service.resolve('u-1', PAGE)).resolves.toEqual({
      allowed: true,
      canEdit: true,
    });
  });

  it('reader пускается только на чтение', async () => {
    const { service } = build({ roles: [{ userId: 'u-1', role: 'reader' }] });

    await expect(service.resolve('u-1', PAGE)).resolves.toEqual({
      allowed: true,
      canEdit: false,
    });
  });

  /**
   * `getUserSpaceRoles` возвращает `undefined`, а не пустой массив, когда
   * доступа нет. Проверка обязана понимать оба варианта.
   */
  it('без ролей доступа нет', async () => {
    const { service } = build({ roles: undefined });

    await expect(service.resolve('u-1', PAGE)).resolves.toEqual({
      allowed: false,
      canEdit: false,
    });
  });

  it('пустой список ролей это тоже отсутствие доступа', async () => {
    const { service } = build({ roles: [] });

    await expect(service.resolve('u-1', PAGE)).resolves.toEqual({
      allowed: false,
      canEdit: false,
    });
  });

  it('берется наивысшая роль из нескольких', async () => {
    const { service } = build({
      roles: [
        { userId: 'u-1', role: 'reader' },
        { userId: 'u-1', role: 'admin' },
      ],
    });

    await expect(service.resolve('u-1', PAGE)).resolves.toEqual({
      allowed: true,
      canEdit: true,
    });
  });

  // Права страницы не запрашиваются, если в space доступа нет вовсе.
  it('при отсутствии роли права страницы не запрашиваются', async () => {
    const { service, pagePermissionRepo } = build({ roles: undefined });

    await service.resolve('u-1', PAGE);

    expect(pagePermissionRepo.canUserEditPage).not.toHaveBeenCalled();
  });
});

describe('CollabAccessService, ограничения на странице', () => {
  it('при ограничениях решает право страницы, а не роль в space', async () => {
    const { service } = build({
      roles: [{ userId: 'u-1', role: 'admin' }],
      restriction: { hasAnyRestriction: true, canAccess: true, canEdit: false },
    });

    await expect(service.resolve('u-1', PAGE)).resolves.toEqual({
      allowed: true,
      canEdit: false,
    });
  });

  it('запрет доступа к странице перекрывает роль в space', async () => {
    const { service } = build({
      roles: [{ userId: 'u-1', role: 'admin' }],
      restriction: {
        hasAnyRestriction: true,
        canAccess: false,
        canEdit: false,
      },
    });

    await expect(service.resolve('u-1', PAGE)).resolves.toEqual({
      allowed: false,
      canEdit: false,
    });
  });

  it('разрешение на странице дает правку читателю space', async () => {
    const { service } = build({
      roles: [{ userId: 'u-1', role: 'reader' }],
      restriction: { hasAnyRestriction: true, canAccess: true, canEdit: true },
    });

    await expect(service.resolve('u-1', PAGE)).resolves.toEqual({
      allowed: true,
      canEdit: true,
    });
  });
});

describe('CollabAccessService, удаленная страница', () => {
  it('открывается только на чтение', async () => {
    const { service } = build();

    await expect(
      service.resolve('u-1', { ...PAGE, deletedAt: new Date() }),
    ).resolves.toEqual({ allowed: true, canEdit: false });
  });
});
