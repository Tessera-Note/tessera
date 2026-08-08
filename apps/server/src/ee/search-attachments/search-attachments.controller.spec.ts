import { ForbiddenException } from '@nestjs/common';
import { SearchAttachmentsController } from './search-attachments.controller';

const user = { id: 'user-1' } as any;
const workspace = { id: 'workspace-1' } as any;

function build(canManage = true) {
  const searchService = {
    search: jest.fn().mockResolvedValue({ items: [] }),
    triggerIndexing: jest.fn().mockResolvedValue({ success: true }),
  };
  const workspaceAbility = {
    createForUser: jest.fn().mockReturnValue({ cannot: () => !canManage }),
  };

  const controller = new SearchAttachmentsController(
    searchService as any,
    workspaceAbility as any,
  );

  return { controller, searchService };
}

describe('SearchAttachmentsController', () => {
  it('passes the caller id down to the search', async () => {
    const { controller, searchService } = build();

    await controller.search({ query: 'nota' } as any, user, workspace);

    expect(searchService.search).toHaveBeenCalledWith(
      'nota',
      'workspace-1',
      'user-1',
      undefined,
    );
  });

  it('refuses indexing for a non-admin', async () => {
    const { controller, searchService } = build(false);

    await expect(
      controller.triggerIndexing(user, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(searchService.triggerIndexing).not.toHaveBeenCalled();
  });

  it('indexes only the caller workspace', async () => {
    const { controller, searchService } = build();

    await controller.triggerIndexing(user, workspace);

    expect(searchService.triggerIndexing).toHaveBeenCalledWith('workspace-1');
  });
});
