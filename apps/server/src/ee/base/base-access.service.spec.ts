import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BaseAccessService } from './base-access.service';

const user = { id: 'user-1' } as any;

const basePage = {
  id: 'page-1',
  spaceId: 'space-1',
  workspaceId: 'workspace-1',
  isBase: true,
  deletedAt: null,
} as any;

function build(overrides: Record<string, any> = {}) {
  const pageRepo = { findById: jest.fn().mockResolvedValue(basePage) };
  const pageAccessService = {
    validateCanView: jest.fn(),
    validateCanEdit: jest.fn(),
    validateCanViewWithPermissions: jest
      .fn()
      .mockResolvedValue({ canEdit: true, hasRestriction: false }),
  };
  const spaceAbility = {
    createForUser: jest.fn().mockResolvedValue({ cannot: () => false }),
  };

  Object.assign(pageRepo, overrides.pageRepo ?? {});
  Object.assign(pageAccessService, overrides.pageAccessService ?? {});
  Object.assign(spaceAbility, overrides.spaceAbility ?? {});

  const service = new BaseAccessService(
    pageRepo as any,
    pageAccessService as any,
    spaceAbility as any,
  );

  return { service, pageRepo, pageAccessService, spaceAbility };
}

describe('BaseAccessService', () => {
  it('rejects a base the user cannot view', async () => {
    const { service } = build({
      pageAccessService: {
        validateCanView: jest.fn().mockRejectedValue(new ForbiddenException()),
      },
    });

    await expect(
      service.assertCanViewBase('page-1', user, 'workspace-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a base the user cannot edit', async () => {
    const { service } = build({
      pageAccessService: {
        validateCanEdit: jest.fn().mockRejectedValue(new ForbiddenException()),
      },
    });

    await expect(
      service.assertCanEditBase('page-1', user, 'workspace-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a page from another workspace', async () => {
    const { service } = build({
      pageRepo: {
        findById: jest
          .fn()
          .mockResolvedValue({ ...basePage, workspaceId: 'other-workspace' }),
      },
    });

    await expect(
      service.assertCanViewBase('page-1', user, 'workspace-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a page that is not a base', async () => {
    const { service } = build({
      pageRepo: {
        findById: jest.fn().mockResolvedValue({ ...basePage, isBase: false }),
      },
    });

    await expect(
      service.assertCanViewBase('page-1', user, 'workspace-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows convert on a page that is not a base yet', async () => {
    const { service, pageAccessService } = build({
      pageRepo: {
        findById: jest.fn().mockResolvedValue({ ...basePage, isBase: false }),
      },
    });

    await expect(
      service.assertCanEditPage('page-1', user, 'workspace-1'),
    ).resolves.toMatchObject({ id: 'page-1' });
    expect(pageAccessService.validateCanEdit).toHaveBeenCalled();
  });

  it('returns the page when access is granted', async () => {
    const { service, pageAccessService } = build();

    const page = await service.assertCanViewBase('page-1', user, 'workspace-1');

    expect(page.id).toBe('page-1');
    expect(pageAccessService.validateCanView).toHaveBeenCalledWith(
      basePage,
      user,
    );
  });

  it('rejects listing bases of a space the user cannot read', async () => {
    const { service } = build({
      spaceAbility: {
        createForUser: jest.fn().mockResolvedValue({ cannot: () => true }),
      },
    });

    await expect(
      service.assertCanViewSpace('space-1', user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects creating a base in a space the user cannot write', async () => {
    const { service } = build({
      spaceAbility: {
        createForUser: jest.fn().mockResolvedValue({ cannot: () => true }),
      },
    });

    await expect(
      service.assertCanCreateInSpace('space-1', user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('resolveBasePermissions', () => {
    it('отдает фактические права на правку', async () => {
      const { service, pageAccessService } = build({
        pageAccessService: {
          validateCanViewWithPermissions: jest
            .fn()
            .mockResolvedValue({ canEdit: false, hasRestriction: true }),
        },
      });

      const result = await service.resolveBasePermissions(
        'page-1',
        user,
        'workspace-1',
      );

      expect(result.canEdit).toBe(false);
      expect(result.hasRestriction).toBe(true);
      expect(result.page.id).toBe('page-1');
      expect(
        pageAccessService.validateCanViewWithPermissions,
      ).toHaveBeenCalled();
    });

    it('пробрасывает отказ в просмотре', async () => {
      const { service } = build({
        pageAccessService: {
          validateCanViewWithPermissions: jest
            .fn()
            .mockRejectedValue(new ForbiddenException()),
        },
      });

      await expect(
        service.resolveBasePermissions('page-1', user, 'workspace-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('не отдает права на страницу, которая не является base', async () => {
      const { service } = build({
        pageRepo: {
          findById: jest.fn().mockResolvedValue({ ...basePage, isBase: false }),
        },
      });

      await expect(
        service.resolveBasePermissions('page-1', user, 'workspace-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
