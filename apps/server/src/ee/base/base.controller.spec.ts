import { ForbiddenException } from '@nestjs/common';
import { BaseController } from './base.controller';

const user = { id: 'user-1' } as any;
const workspace = { id: 'workspace-1' } as any;
const page = { id: 'page-1', spaceId: 'space-1' } as any;

function build() {
  const baseService: Record<string, jest.Mock> = {
    createBase: jest.fn().mockResolvedValue({}),
    getBaseInfo: jest.fn().mockResolvedValue({}),
    updateBase: jest.fn().mockResolvedValue({}),
    deleteBase: jest.fn().mockResolvedValue({}),
    convertPageToBase: jest.fn().mockResolvedValue(page),
    exportToCsv: jest.fn().mockResolvedValue('a,b'),
    listBases: jest.fn().mockResolvedValue([]),
    createProperty: jest.fn().mockResolvedValue({}),
    updateProperty: jest.fn().mockResolvedValue({}),
    deleteProperty: jest.fn().mockResolvedValue({}),
    reorderProperty: jest.fn().mockResolvedValue({}),
    createRow: jest.fn().mockResolvedValue({}),
    getRowInfo: jest.fn().mockResolvedValue({}),
    updateRow: jest.fn().mockResolvedValue({}),
    deleteRow: jest.fn().mockResolvedValue({}),
    deleteRows: jest.fn().mockResolvedValue({}),
    listRows: jest.fn().mockResolvedValue({ items: [] }),
    reorderRow: jest.fn().mockResolvedValue({}),
    createView: jest.fn().mockResolvedValue({}),
    updateView: jest.fn().mockResolvedValue({}),
    deleteView: jest.fn().mockResolvedValue({}),
    listViews: jest.fn().mockResolvedValue([]),
  };

  const access = {
    assertCanViewBase: jest.fn().mockResolvedValue(page),
    resolveBasePermissions: jest
      .fn()
      .mockResolvedValue({ page, canEdit: true, hasRestriction: false }),
    assertCanEditBase: jest.fn().mockResolvedValue(page),
    assertCanEditPage: jest.fn().mockResolvedValue(page),
    assertCanViewSpace: jest.fn().mockResolvedValue(undefined),
    assertCanCreateInSpace: jest.fn().mockResolvedValue(undefined),
  };

  const wsService = { emitTreeRefresh: jest.fn() };
  const controller = new BaseController(
    baseService as any,
    access as any,
    wsService as any,
  );
  return { controller, baseService, access, wsService };
}

const res = { header: jest.fn(), send: jest.fn() } as any;

// [endpoint, invocação, args esperados na guarda de leitura/edição]
const readEndpoints: [
  string,
  (c: BaseController) => Promise<unknown>,
  unknown[],
][] = [
  // info в этом списке нет: он проверяет доступ через resolveBasePermissions,
  // которому кроме проверки нужно вернуть фактическое право на правку.
  // Для него отдельные проверки ниже.
  [
    'rows/info',
    (c) =>
      c.getRowInfo(
        { pageId: 'page-1', rowId: 'row-1' } as any,
        user,
        workspace,
      ),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'rows',
    (c) => c.listRows({ pageId: 'page-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'views',
    (c) => c.listViews({ pageId: 'page-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'export-csv',
    (c) => c.exportBaseToCsv({ pageId: 'page-1' } as any, user, workspace, res),
    ['page-1', user, 'workspace-1'],
  ],
];

const writeEndpoints: [
  string,
  (c: BaseController) => Promise<unknown>,
  unknown[],
][] = [
  [
    'update',
    (c) => c.updateBase({ pageId: 'page-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'delete',
    (c) => c.deleteBase({ pageId: 'page-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'properties/create',
    (c) => c.createProperty({ pageId: 'page-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'properties/update',
    (c) => c.updateProperty({ pageId: 'page-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'properties/delete',
    (c) =>
      c.deleteProperty(
        { pageId: 'page-1', propertyId: 'prop-1' } as any,
        user,
        workspace,
      ),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'properties/reorder',
    (c) =>
      c.reorderProperty(
        { pageId: 'page-1', propertyId: 'prop-1', position: 'a' } as any,
        user,
        workspace,
      ),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'rows/create',
    (c) => c.createRow({ pageId: 'page-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'rows/update',
    (c) =>
      c.updateRow({ pageId: 'page-1', rowId: 'row-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'rows/delete',
    (c) =>
      c.deleteRow({ pageId: 'page-1', rowId: 'row-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'rows/delete-many',
    (c) =>
      c.deleteRows(
        { pageId: 'page-1', rowIds: ['row-1'] } as any,
        user,
        workspace,
      ),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'rows/reorder',
    (c) =>
      c.reorderRow(
        { pageId: 'page-1', rowId: 'row-1', position: 'a' } as any,
        user,
        workspace,
      ),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'views/create',
    (c) => c.createView({ pageId: 'page-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'views/update',
    (c) =>
      c.updateView({ pageId: 'page-1', viewId: 'v-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
  [
    'views/delete',
    (c) =>
      c.deleteView({ pageId: 'page-1', viewId: 'v-1' } as any, user, workspace),
    ['page-1', user, 'workspace-1'],
  ],
];

describe('BaseController authorization', () => {
  it.each(readEndpoints)(
    '%s refuses a base the user cannot view',
    async (_name, call, expectedArgs) => {
      const { controller, access, baseService } = build();
      access.assertCanViewBase.mockRejectedValue(new ForbiddenException());

      await expect(call(controller)).rejects.toBeInstanceOf(ForbiddenException);

      expect(access.assertCanViewBase).toHaveBeenCalledWith(...expectedArgs);
      for (const fn of Object.values(baseService)) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it.each(writeEndpoints)(
    '%s refuses a base the user cannot edit',
    async (_name, call, expectedArgs) => {
      const { controller, access, baseService } = build();
      access.assertCanEditBase.mockRejectedValue(new ForbiddenException());

      await expect(call(controller)).rejects.toBeInstanceOf(ForbiddenException);

      expect(access.assertCanEditBase).toHaveBeenCalledWith(...expectedArgs);
      for (const fn of Object.values(baseService)) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it('listBases refuses a space the user is not a member of', async () => {
    const { controller, access, baseService } = build();
    access.assertCanViewSpace.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.listBases({ spaceId: 'space-1' } as any, user, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertCanViewSpace).toHaveBeenCalledWith('space-1', user);
    expect(baseService.listBases).not.toHaveBeenCalled();
  });

  it('createBase checks the target space', async () => {
    const { controller, access, baseService } = build();
    access.assertCanCreateInSpace.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.createBase({ spaceId: 'space-1' } as any, user, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertCanCreateInSpace).toHaveBeenCalledWith('space-1', user);
    expect(baseService.createBase).not.toHaveBeenCalled();
  });

  it('createBase under a parent page checks the parent', async () => {
    const { controller, access, baseService } = build();
    access.assertCanEditPage.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.createBase(
        { parentPageId: 'parent-1' } as any,
        user,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertCanEditPage).toHaveBeenCalledWith(
      'parent-1',
      user,
      'workspace-1',
    );
    expect(baseService.createBase).not.toHaveBeenCalled();
  });

  it('convert checks edit on the page being converted', async () => {
    const { controller, access, baseService } = build();
    access.assertCanEditPage.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.convertPageToBase(
        { pageId: 'page-1' } as any,
        user,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.assertCanEditPage).toHaveBeenCalledWith(
      'page-1',
      user,
      'workspace-1',
    );
    expect(baseService.convertPageToBase).not.toHaveBeenCalled();
  });

  it('info refuses a base the user cannot view', async () => {
    const { controller, access, baseService } = build();
    access.resolveBasePermissions.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.getBaseInfo({ pageId: 'page-1' } as any, user, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(access.resolveBasePermissions).toHaveBeenCalledWith(
      'page-1',
      user,
      'workspace-1',
    );
    expect(baseService.getBaseInfo).not.toHaveBeenCalled();
  });

  it('lets an authorized read through', async () => {
    const { controller, baseService } = build();

    await controller.getBaseInfo({ pageId: 'page-1' } as any, user, workspace);

    expect(baseService.getBaseInfo).toHaveBeenCalledWith(
      'page-1',
      'workspace-1',
      { canEdit: true, hasRestriction: false },
    );
  });

  // Регресс: getBaseInfo возвращал canEdit: true константой, и читатель
  // пространства получал редактируемый интерфейс.
  it('прокидывает фактические права читателя', async () => {
    const { controller, access, baseService } = build();
    access.resolveBasePermissions.mockResolvedValue({
      page,
      canEdit: false,
      hasRestriction: true,
    });

    await controller.getBaseInfo({ pageId: 'page-1' } as any, user, workspace);

    expect(baseService.getBaseInfo).toHaveBeenCalledWith(
      'page-1',
      'workspace-1',
      { canEdit: false, hasRestriction: true },
    );
  });
});
