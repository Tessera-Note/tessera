import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '../../common/helpers/types/permission';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { PageService } from '../../core/page/services/page.service';
import { SpaceMemberRepo } from '../../database/repos/space/space-member.repo';
import { SpaceRepo } from '../../database/repos/space/space.repo';
import { TemplateRepo } from '../../database/repos/template/template.repo';
import { Template, User, Workspace } from '../../database/types/entity.types';
import { IAuditService } from '../../integrations/audit/audit.service';
import { ListTemplatesDto } from './dto/template.dto';
import { TemplateService } from './template.service';

type TemplateRepoMock = {
  findById: jest.MockedFunction<TemplateRepo['findById']>;
  findTemplates: jest.MockedFunction<TemplateRepo['findTemplates']>;
  insertTemplate: jest.MockedFunction<TemplateRepo['insertTemplate']>;
  updateTemplate: jest.MockedFunction<TemplateRepo['updateTemplate']>;
  deleteTemplate: jest.MockedFunction<TemplateRepo['deleteTemplate']>;
};

type SpaceRepoMock = {
  findById: jest.MockedFunction<SpaceRepo['findById']>;
};

type SpaceMemberRepoMock = {
  getUserSpaceIds: jest.MockedFunction<SpaceMemberRepo['getUserSpaceIds']>;
};

type PageServiceMock = {
  create: jest.MockedFunction<PageService['create']>;
  findById: jest.MockedFunction<PageService['findById']>;
};

type PageAccessServiceMock = {
  validateCanEdit: jest.MockedFunction<PageAccessService['validateCanEdit']>;
};

type AuditServiceMock = {
  log: jest.MockedFunction<IAuditService['log']>;
};

type SpaceAbilityMock = {
  createForUser: jest.MockedFunction<SpaceAbilityFactory['createForUser']>;
};

type WorkspaceAbilityMock = {
  createForUser: jest.MockedFunction<WorkspaceAbilityFactory['createForUser']>;
};

const workspace = {
  id: 'workspace-1',
  settings: { templates: { allowMemberTemplates: false } },
} as unknown as Workspace;

const admin = { id: 'admin-1', role: UserRole.ADMIN } as User;
const member = { id: 'member-1', role: UserRole.MEMBER } as User;
const content = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
};

const template = (overrides: Partial<Template> = {}) =>
  ({
    id: 'template-1',
    title: 'Template title',
    description: 'Description',
    icon: 'book',
    content,
    spaceId: null,
    workspaceId: workspace.id,
    creatorId: admin.id,
    lastUpdatedById: admin.id,
    ...overrides,
  }) as Template;

describe('TemplateService', () => {
  let service: TemplateService;
  let templateRepo: TemplateRepoMock;
  let spaceRepo: SpaceRepoMock;
  let spaceMemberRepo: SpaceMemberRepoMock;
  let pageService: PageServiceMock;
  let pageAccessService: PageAccessServiceMock;
  let spaceAbility: SpaceAbilityMock;
  let workspaceAbility: WorkspaceAbilityMock;
  let auditService: AuditServiceMock;
  let canSpace: jest.Mock<boolean, [SpaceCaslAction, SpaceCaslSubject]>;
  let canWorkspace: jest.Mock<
    boolean,
    [WorkspaceCaslAction, WorkspaceCaslSubject]
  >;

  beforeEach(() => {
    templateRepo = {
      findById: jest.fn(),
      findTemplates: jest.fn(),
      insertTemplate: jest.fn(),
      updateTemplate: jest.fn().mockResolvedValue(true as never),
      deleteTemplate: jest.fn().mockResolvedValue(true as never),
    };
    spaceRepo = { findById: jest.fn() };
    spaceMemberRepo = { getUserSpaceIds: jest.fn() };
    pageService = { create: jest.fn(), findById: jest.fn() };
    pageAccessService = { validateCanEdit: jest.fn() };
    canSpace = jest.fn().mockReturnValue(true);
    canWorkspace = jest.fn().mockReturnValue(true);
    spaceAbility = {
      createForUser: jest.fn().mockResolvedValue({ can: canSpace }),
    } as unknown as SpaceAbilityMock;
    workspaceAbility = {
      createForUser: jest.fn().mockReturnValue({ can: canWorkspace }),
    } as unknown as WorkspaceAbilityMock;
    auditService = { log: jest.fn() };

    service = new TemplateService(
      templateRepo as unknown as TemplateRepo,
      spaceRepo as unknown as SpaceRepo,
      spaceMemberRepo as unknown as SpaceMemberRepo,
      pageService as unknown as PageService,
      pageAccessService as unknown as PageAccessService,
      spaceAbility as unknown as SpaceAbilityFactory,
      workspaceAbility as unknown as WorkspaceAbilityFactory,
      auditService as unknown as IAuditService,
    );
  });

  it('lists only templates in accessible spaces and forwards pagination', async () => {
    const dto = Object.assign(new ListTemplatesDto(), {
      limit: 25,
      cursor: 'cursor',
      spaceId: 'space-1',
    });
    const result = { items: [template()], meta: {} };
    spaceMemberRepo.getUserSpaceIds.mockResolvedValue(['space-1', 'space-2']);
    templateRepo.findTemplates.mockResolvedValue(result as never);

    await expect(service.listTemplates(dto, member, workspace)).resolves.toBe(
      result,
    );
    expect(templateRepo.findTemplates).toHaveBeenCalledWith(
      workspace.id,
      ['space-1', 'space-2'],
      dto,
      { spaceId: 'space-1' },
    );
  });

  it('allows every workspace member to read a global template', async () => {
    const globalTemplate = template();
    templateRepo.findById.mockResolvedValue(globalTemplate);

    await expect(
      service.getTemplate(globalTemplate.id, member, workspace),
    ).resolves.toBe(globalTemplate);
    expect(spaceAbility.createForUser).not.toHaveBeenCalled();
  });

  it('requires page read permission for a space template', async () => {
    const scopedTemplate = template({ spaceId: 'space-1' });
    templateRepo.findById.mockResolvedValue(scopedTemplate);

    await expect(
      service.getTemplate(scopedTemplate.id, member, workspace),
    ).resolves.toBe(scopedTemplate);
    expect(canSpace).toHaveBeenCalledWith(
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
  });

  it('hides missing and cross-workspace templates with a 404', async () => {
    templateRepo.findById.mockResolvedValue(undefined);

    await expect(
      service.getTemplate('outside-template', member, workspace),
    ).rejects.toEqual(new NotFoundException('Template not found'));
    expect(templateRepo.findById).toHaveBeenCalledWith(
      'outside-template',
      workspace.id,
      { includeContent: true },
    );
  });

  it('returns 403 when a found space template is not readable', async () => {
    templateRepo.findById.mockResolvedValue(
      template({ spaceId: 'space-private' }),
    );
    canSpace.mockReturnValue(false);

    await expect(
      service.getTemplate('template-1', member, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('converts missing space membership to 403 after finding the template', async () => {
    templateRepo.findById.mockResolvedValue(
      template({ spaceId: 'space-private' }),
    );
    spaceAbility.createForUser.mockRejectedValue(
      new NotFoundException('Space permissions not found'),
    );

    await expect(
      service.getTemplate('template-1', member, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an admin to create a normalized global template', async () => {
    templateRepo.insertTemplate.mockResolvedValue({ id: 'new-template' });
    const created = template({ id: 'new-template' });
    templateRepo.findById.mockResolvedValue(created);

    await expect(
      service.createTemplate(
        { title: 'Template title', description: 'Description', content },
        admin,
        workspace,
      ),
    ).resolves.toBe(created);

    expect(canWorkspace).toHaveBeenCalledWith(
      WorkspaceCaslAction.Manage,
      WorkspaceCaslSubject.Settings,
    );
    expect(templateRepo.insertTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Template title',
        description: 'Description',
        spaceId: null,
        workspaceId: workspace.id,
        creatorId: admin.id,
        lastUpdatedById: admin.id,
        content: expect.objectContaining({
          type: 'doc',
          content: [
            expect.objectContaining({
              type: 'paragraph',
              attrs: expect.objectContaining({
                id: null,
                indent: 0,
                textAlign: null,
              }),
            }),
          ],
        }),
        textContent: 'Hello',
        ydoc: expect.any(Buffer),
      }),
    );
  });

  it('uses an empty document when create content is absent', async () => {
    templateRepo.insertTemplate.mockResolvedValue({ id: 'new-template' });
    templateRepo.findById.mockResolvedValue(template({ id: 'new-template' }));

    await service.createTemplate({ title: 'Blank' }, admin, workspace);

    expect(templateRepo.insertTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          type: 'doc',
          content: [expect.objectContaining({ type: 'paragraph' })],
        }),
      }),
    );
  });

  it('returns 400 for invalid create content', async () => {
    await expect(
      service.createTemplate(
        { title: 'Broken', content: { type: 'definitely-invalid' } },
        admin,
        workspace,
      ),
    ).rejects.toEqual(new BadRequestException('Invalid content format'));
  });

  it.each([UserRole.ADMIN, UserRole.OWNER])(
    'allows a workspace %s to create in an editable space when member templates are disabled',
    async (role) => {
      const privilegedUser = { id: `${role}-1`, role } as User;
      spaceRepo.findById.mockResolvedValue({ id: 'space-1' } as never);
      templateRepo.insertTemplate.mockResolvedValue({ id: 'new-template' });
      templateRepo.findById.mockResolvedValue(
        template({
          id: 'new-template',
          spaceId: 'space-1',
          creatorId: privilegedUser.id,
          lastUpdatedById: privilegedUser.id,
        }),
      );

      await service.createTemplate(
        { title: 'Privileged template', spaceId: 'space-1' },
        privilegedUser,
        workspace,
      );

      expect(canSpace).toHaveBeenCalledWith(
        SpaceCaslAction.Edit,
        SpaceCaslSubject.Page,
      );
      expect(templateRepo.insertTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: 'space-1',
          creatorId: privilegedUser.id,
        }),
      );
    },
  );

  it('allows a normal member to create in an editable space when enabled', async () => {
    const enabledWorkspace = {
      ...workspace,
      settings: { templates: { allowMemberTemplates: true } },
    } as Workspace;
    spaceRepo.findById.mockResolvedValue({ id: 'space-1' } as never);
    templateRepo.insertTemplate.mockResolvedValue({ id: 'new-template' });
    templateRepo.findById.mockResolvedValue(
      template({ id: 'new-template', spaceId: 'space-1' }),
    );

    await service.createTemplate(
      { title: 'Member template', spaceId: 'space-1' },
      member,
      enabledWorkspace,
    );

    expect(canSpace).toHaveBeenCalledWith(
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );
    expect(templateRepo.insertTemplate).toHaveBeenCalled();
  });

  it('denies a normal member space creation when member templates are disabled', async () => {
    spaceRepo.findById.mockResolvedValue({ id: 'space-1' } as never);

    await expect(
      service.createTemplate(
        { title: 'Member template', spaceId: 'space-1' },
        member,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(templateRepo.insertTemplate).not.toHaveBeenCalled();
  });

  it('denies a space reader from creating templates even when enabled', async () => {
    const enabledWorkspace = {
      ...workspace,
      settings: { templates: { allowMemberTemplates: true } },
    } as Workspace;
    spaceRepo.findById.mockResolvedValue({ id: 'space-1' } as never);
    canSpace.mockReturnValue(false);

    await expect(
      service.createTemplate(
        { title: 'Reader template', spaceId: 'space-1' },
        member,
        enabledWorkspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 404 when the create destination space is outside the workspace', async () => {
    spaceRepo.findById.mockResolvedValue(undefined);

    await expect(
      service.createTemplate(
        { title: 'Outside', spaceId: 'outside-space' },
        admin,
        workspace,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates only supplied fields and derived content fields', async () => {
    const current = template({ spaceId: 'space-1' });
    const updated = template({ spaceId: 'space-1', title: 'Updated' });
    templateRepo.findById
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(updated);

    await expect(
      service.updateTemplate(
        { templateId: current.id, title: 'Updated', content },
        admin,
        workspace,
      ),
    ).resolves.toBe(updated);

    expect(templateRepo.updateTemplate).toHaveBeenCalledWith(
      {
        title: 'Updated',
        content: expect.objectContaining({
          type: 'doc',
          content: [expect.objectContaining({ type: 'paragraph' })],
        }),
        textContent: 'Hello',
        ydoc: expect.any(Buffer),
        lastUpdatedById: admin.id,
      },
      current.id,
      workspace.id,
      current.spaceId,
    );
  });

  it('denies a member update in an editable space when member templates are disabled before no-op validation', async () => {
    const current = template({ spaceId: 'space-1' });
    templateRepo.findById.mockResolvedValue(current);

    await expect(
      service.updateTemplate({ templateId: current.id }, member, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(canSpace).toHaveBeenCalledWith(
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );
    expect(templateRepo.updateTemplate).not.toHaveBeenCalled();
  });

  it('allows a member update in an editable space when member templates are enabled', async () => {
    const enabledWorkspace = {
      ...workspace,
      settings: { templates: { allowMemberTemplates: true } },
    } as Workspace;
    const current = template({ spaceId: 'space-1' });
    const updated = template({ spaceId: 'space-1', title: 'Updated' });
    templateRepo.findById
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(updated);

    await expect(
      service.updateTemplate(
        { templateId: current.id, title: 'Updated' },
        member,
        enabledWorkspace,
      ),
    ).resolves.toBe(updated);
    expect(templateRepo.updateTemplate).toHaveBeenCalled();
  });

  it('persists an explicit null icon', async () => {
    const current = template({ spaceId: 'space-1' });
    const updated = template({ spaceId: 'space-1', icon: null });
    templateRepo.findById
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(updated);

    await service.updateTemplate(
      { templateId: current.id, icon: null },
      admin,
      workspace,
    );

    expect(templateRepo.updateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ icon: null }),
      current.id,
      workspace.id,
      current.spaceId,
    );
  });

  it('leaves the icon unchanged when it is omitted', async () => {
    const current = template({ spaceId: 'space-1', icon: 'book' });
    templateRepo.findById
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current);

    await service.updateTemplate(
      { templateId: current.id, title: 'Renamed' },
      admin,
      workspace,
    );

    expect(templateRepo.updateTemplate).toHaveBeenCalledWith(
      expect.not.objectContaining({ icon: expect.anything() }),
      current.id,
      workspace.id,
      current.spaceId,
    );
  });

  it('returns 403 for an unauthorized update with no mutable fields', async () => {
    templateRepo.findById.mockResolvedValue(template());
    canWorkspace.mockReturnValue(false);

    await expect(
      service.updateTemplate({ templateId: 'template-1' }, member, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(templateRepo.updateTemplate).not.toHaveBeenCalled();
  });

  it('returns 400 for an authorized update with no mutable fields', async () => {
    templateRepo.findById.mockResolvedValue(template());

    await expect(
      service.updateTemplate({ templateId: 'template-1' }, admin, workspace),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(canWorkspace).toHaveBeenCalledWith(
      WorkspaceCaslAction.Manage,
      WorkspaceCaslSubject.Settings,
    );
    expect(templateRepo.updateTemplate).not.toHaveBeenCalled();
  });

  it('retains the existing scope when spaceId is omitted', async () => {
    const current = template({ spaceId: 'space-1' });
    templateRepo.findById
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current);

    await service.updateTemplate(
      { templateId: current.id, title: 'Renamed' },
      admin,
      workspace,
    );

    expect(spaceRepo.findById).not.toHaveBeenCalled();
    expect(templateRepo.updateTemplate).toHaveBeenCalledWith(
      expect.not.objectContaining({ spaceId: expect.anything() }),
      current.id,
      workspace.id,
      current.spaceId,
    );
  });

  it('requires source and target edit permissions when moving between spaces', async () => {
    const current = template({ spaceId: 'source-space' });
    templateRepo.findById
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(template({ spaceId: 'target-space' }));
    spaceRepo.findById.mockResolvedValue({ id: 'target-space' } as never);

    await service.updateTemplate(
      { templateId: current.id, spaceId: 'target-space' },
      admin,
      workspace,
    );

    expect(spaceAbility.createForUser).toHaveBeenNthCalledWith(
      1,
      admin,
      'source-space',
    );
    expect(spaceAbility.createForUser).toHaveBeenNthCalledWith(
      2,
      admin,
      'target-space',
    );
    expect(spaceAbility.createForUser).toHaveBeenNthCalledWith(
      3,
      admin,
      'target-space',
    );
    expect(canSpace).toHaveBeenNthCalledWith(
      1,
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );
    expect(canSpace).toHaveBeenNthCalledWith(
      2,
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );
    expect(canSpace).toHaveBeenNthCalledWith(
      3,
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
  });

  it('passes a null expected source scope when updating a global template', async () => {
    const current = template();
    templateRepo.findById
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current);

    await service.updateTemplate(
      { templateId: current.id, title: 'Renamed' },
      admin,
      workspace,
    );

    expect(templateRepo.updateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Renamed' }),
      current.id,
      workspace.id,
      null,
    );
  });

  it('reauthorizes the refetched scope before returning an updated template', async () => {
    const current = template({ spaceId: 'source-space' });
    const concurrentlyMoved = template({ spaceId: 'inaccessible-space' });
    templateRepo.findById
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(concurrentlyMoved);
    canSpace.mockReturnValueOnce(true).mockReturnValueOnce(false);

    await expect(
      service.updateTemplate(
        { templateId: current.id, title: 'Renamed' },
        admin,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(spaceAbility.createForUser).toHaveBeenNthCalledWith(
      1,
      admin,
      'source-space',
    );
    expect(spaceAbility.createForUser).toHaveBeenNthCalledWith(
      2,
      admin,
      'inaccessible-space',
    );
  });

  it('requires workspace settings permission when moving a space template global', async () => {
    const current = template({ spaceId: 'source-space' });
    templateRepo.findById.mockResolvedValue(current);
    canWorkspace.mockReturnValue(false);

    await expect(
      service.updateTemplate(
        { templateId: current.id, spaceId: null },
        admin,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(templateRepo.updateTemplate).not.toHaveBeenCalled();
  });

  it('returns 409 when the authorized source scope changes before update', async () => {
    const current = template({ spaceId: 'source-space' });
    templateRepo.findById.mockResolvedValue(current);
    templateRepo.updateTemplate.mockResolvedValue(false as never);

    await expect(
      service.updateTemplate(
        { templateId: current.id, title: 'Changed' },
        admin,
        workspace,
      ),
    ).rejects.toEqual(
      new ConflictException('Template scope changed. Please retry'),
    );
    expect(templateRepo.findById).toHaveBeenCalledTimes(1);
  });

  it('requires global source permission before moving into a space', async () => {
    templateRepo.findById.mockResolvedValue(template());
    canWorkspace.mockReturnValue(false);

    await expect(
      service.updateTemplate(
        { templateId: 'template-1', spaceId: 'space-1' },
        member,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(spaceRepo.findById).not.toHaveBeenCalled();
  });

  it('deletes a template after authorizing its current scope', async () => {
    templateRepo.findById.mockResolvedValue(template({ spaceId: 'space-1' }));

    await service.deleteTemplate('template-1', admin, workspace);

    expect(canSpace).toHaveBeenCalledWith(
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );
    expect(templateRepo.deleteTemplate).toHaveBeenCalledWith(
      'template-1',
      workspace.id,
      'space-1',
    );
  });

  it('denies a member delete in an editable space when member templates are disabled', async () => {
    templateRepo.findById.mockResolvedValue(template({ spaceId: 'space-1' }));

    await expect(
      service.deleteTemplate('template-1', member, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(canSpace).toHaveBeenCalledWith(
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );
    expect(templateRepo.deleteTemplate).not.toHaveBeenCalled();
  });

  it('allows a member delete in an editable space when member templates are enabled', async () => {
    const enabledWorkspace = {
      ...workspace,
      settings: { templates: { allowMemberTemplates: true } },
    } as Workspace;
    templateRepo.findById.mockResolvedValue(template({ spaceId: 'space-1' }));

    await service.deleteTemplate('template-1', member, enabledWorkspace);

    expect(templateRepo.deleteTemplate).toHaveBeenCalledWith(
      'template-1',
      workspace.id,
      'space-1',
    );
  });

  it('passes a null expected source scope when deleting a global template', async () => {
    templateRepo.findById.mockResolvedValue(template());

    await service.deleteTemplate('template-1', admin, workspace);

    expect(templateRepo.deleteTemplate).toHaveBeenCalledWith(
      'template-1',
      workspace.id,
      null,
    );
  });

  it('returns 409 when the authorized source scope changes before delete', async () => {
    templateRepo.findById.mockResolvedValue(
      template({ spaceId: 'source-space' }),
    );
    templateRepo.deleteTemplate.mockResolvedValue(false as never);

    await expect(
      service.deleteTemplate('template-1', admin, workspace),
    ).rejects.toEqual(
      new ConflictException('Template scope changed. Please retry'),
    );
  });

  it('uses a template in an editable destination and forwards the parent', async () => {
    const source = template({ spaceId: 'source-space' });
    const createdPage = {
      id: 'page-1',
      title: '',
      spaceId: 'destination-space',
    };
    templateRepo.findById.mockResolvedValue(source);
    spaceRepo.findById.mockResolvedValue({ id: 'destination-space' } as never);
    pageService.findById.mockResolvedValue({
      id: 'parent-page',
      spaceId: 'destination-space',
      deletedAt: null,
    } as never);
    pageService.create.mockResolvedValue(createdPage as never);

    await expect(
      service.useTemplate(
        {
          templateId: source.id,
          spaceId: 'destination-space',
          parentPageId: 'parent-page',
        },
        member,
        workspace,
      ),
    ).resolves.toBe(createdPage);

    expect(canSpace).toHaveBeenCalledWith(
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'parent-page' }),
      member,
    );
    expect(pageService.create).toHaveBeenCalledWith(member.id, workspace.id, {
      title: source.title,
      icon: source.icon,
      spaceId: 'destination-space',
      parentPageId: 'parent-page',
      content,
      format: 'json',
    });
    expect(auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.PAGE_CREATED,
      resourceType: AuditResource.PAGE,
      resourceId: createdPage.id,
      spaceId: createdPage.spaceId,
      changes: {
        after: {
          title: 'untitled',
          spaceId: createdPage.spaceId,
        },
      },
    });
  });

  it('does not audit when page creation from a template fails', async () => {
    templateRepo.findById.mockResolvedValue(template());
    spaceRepo.findById.mockResolvedValue({ id: 'destination-space' } as never);
    const failure = new Error('page creation failed');
    pageService.create.mockRejectedValue(failure);

    await expect(
      service.useTemplate(
        { templateId: 'template-1', spaceId: 'destination-space' },
        member,
        workspace,
      ),
    ).rejects.toBe(failure);
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('allows a space reader with page-level edit access to use a template under a parent', async () => {
    const parent = {
      id: 'parent-page',
      spaceId: 'destination-space',
      deletedAt: null,
    };
    templateRepo.findById.mockResolvedValue(template());
    spaceRepo.findById.mockResolvedValue({ id: 'destination-space' } as never);
    pageService.findById.mockResolvedValue(parent as never);
    pageService.create.mockResolvedValue({ id: 'page-1' } as never);
    canSpace.mockImplementation((action) => action === SpaceCaslAction.Read);

    await expect(
      service.useTemplate(
        {
          templateId: 'template-1',
          spaceId: 'destination-space',
          parentPageId: parent.id,
        },
        member,
        workspace,
      ),
    ).resolves.toEqual({ id: 'page-1' });

    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(
      parent,
      member,
    );
    expect(spaceAbility.createForUser).not.toHaveBeenCalled();
  });

  it('denies a restricted parent when page-level edit access is missing', async () => {
    const parent = {
      id: 'parent-page',
      spaceId: 'destination-space',
      deletedAt: null,
    };
    templateRepo.findById.mockResolvedValue(template());
    spaceRepo.findById.mockResolvedValue({ id: 'destination-space' } as never);
    pageService.findById.mockResolvedValue(parent as never);
    pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException(),
    );

    await expect(
      service.useTemplate(
        {
          templateId: 'template-1',
          spaceId: 'destination-space',
          parentPageId: parent.id,
        },
        member,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pageService.create).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    [
      'deleted',
      {
        id: 'parent-page',
        spaceId: 'destination-space',
        deletedAt: new Date(),
      },
    ],
    [
      'in another space',
      { id: 'parent-page', spaceId: 'other-space', deletedAt: null },
    ],
  ])('returns 404 when the parent page is %s', async (_case, parent) => {
    templateRepo.findById.mockResolvedValue(template());
    spaceRepo.findById.mockResolvedValue({ id: 'destination-space' } as never);
    pageService.findById.mockResolvedValue(parent as never);

    await expect(
      service.useTemplate(
        {
          templateId: 'template-1',
          spaceId: 'destination-space',
          parentPageId: 'parent-page',
        },
        member,
        workspace,
      ),
    ).rejects.toEqual(new NotFoundException('Parent page not found'));
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    expect(pageService.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the use destination does not exist in the workspace', async () => {
    templateRepo.findById.mockResolvedValue(template());
    spaceRepo.findById.mockResolvedValue(undefined);

    await expect(
      service.useTemplate(
        { templateId: 'template-1', spaceId: 'outside-space' },
        member,
        workspace,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(pageService.create).not.toHaveBeenCalled();
  });

  it('returns 403 when a root use destination is read-only', async () => {
    templateRepo.findById.mockResolvedValue(template());
    spaceRepo.findById.mockResolvedValue({ id: 'space-1' } as never);
    canSpace.mockReturnValue(false);

    await expect(
      service.useTemplate(
        { templateId: 'template-1', spaceId: 'space-1' },
        member,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
  });
});
