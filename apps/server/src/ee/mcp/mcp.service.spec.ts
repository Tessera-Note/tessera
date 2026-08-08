import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { McpService } from './mcp.service';

const user = { id: 'user-1' } as any;
const workspace = { id: 'workspace-1' } as any;

const page = {
  id: 'page-1',
  slugId: 'abc123',
  title: 'Page',
  spaceId: 'space-1',
  workspaceId: 'workspace-1',
  parentPageId: null,
  deletedAt: null,
  // A real page always holds a valid ProseMirror doc. `{}` made get_page's
  // happy path throw inside jsonToHtml (Node.fromJSON rejects it), which went
  // unnoticed while this suite could not load at all.
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
} as any;

function buildService(overrides: Partial<Record<string, any>> = {}) {
  const deps: Record<string, any> = {
    db: {},
    pageService: {
      create: jest.fn(),
      update: jest.fn().mockResolvedValue(page),
      removePage: jest.fn(),
    },
    pageRepo: { findById: jest.fn().mockResolvedValue(page) },
    pageAccessService: {
      validateCanView: jest.fn(),
      validateCanEdit: jest.fn(),
    },
    pagePermissionRepo: { filterAccessiblePageIds: jest.fn() },
    spaceMemberRepo: { getUserSpaceIds: jest.fn().mockResolvedValue([]) },
    spaceAbility: { createForUser: jest.fn() },
    baseService: { createBase: jest.fn() },
    searchService: { searchPage: jest.fn().mockResolvedValue({ items: [] }) },
    commentService: { create: jest.fn(), update: jest.fn(), findByPageId: jest.fn() },
    commentRepo: { findById: jest.fn(), deleteComment: jest.fn() },
    labelService: {
      getPageLabels: jest.fn(),
      addLabelsToPage: jest.fn(),
      removeLabelFromPage: jest.fn(),
    },
    labelRepo: { findById: jest.fn(), findByNameAndWorkspace: jest.fn() },
    favoriteService: { addFavorite: jest.fn(), removeFavorite: jest.fn() },
    pageHistoryService: { findById: jest.fn(), findHistoryByPageId: jest.fn() },
    backlinkService: { findByPageId: jest.fn() },
    templateService: { getTemplate: jest.fn(), useTemplate: jest.fn() },
    searchAttachmentsService: { search: jest.fn() },
    attachmentRepo: { findById: jest.fn() },
    attachmentService: { uploadFile: jest.fn() },
    embeddingService: {
      isConfigured: jest.fn().mockReturnValue(true),
      search: jest.fn().mockResolvedValue([]),
      indexPage: jest.fn(),
      findUnindexedPageIds: jest.fn().mockResolvedValue([]),
      countIndexedPages: jest.fn().mockResolvedValue(0),
    },
    exportService: { exportPages: jest.fn() },
    wsService: { emitCommentEvent: jest.fn() },
    auditService: { log: jest.fn() },
    ...overrides,
  };

  // Keep in sync with the McpService constructor order.
  const service = new McpService(
    ...([
      'db',
      'pageService',
      'pageRepo',
      'pageAccessService',
      'pagePermissionRepo',
      'spaceMemberRepo',
      'spaceAbility',
      'baseService',
      'searchService',
      'commentService',
      'commentRepo',
      'labelService',
      'labelRepo',
      'favoriteService',
      'pageHistoryService',
      'backlinkService',
      'templateService',
      'searchAttachmentsService',
      'attachmentRepo',
      'attachmentService',
      'embeddingService',
      'exportService',
      'wsService',
      'auditService',
    ].map((key) => deps[key]) as ConstructorParameters<typeof McpService>),
  );

  return { service, deps };
}

function callTool(service: McpService, name: string, args: any) {
  return service.handleRpcRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    user,
    workspace,
  );
}

describe('McpService permissions', () => {
  it('get_page rejects a page the user cannot view', async () => {
    const { service, deps } = buildService();
    deps.pageAccessService.validateCanView.mockRejectedValue(
      new ForbiddenException(),
    );

    const res: any = await callTool(service, 'get_page', { pageId: 'page-1' });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('do not have permission');
  });

  it('get_page returns the page when access is granted', async () => {
    const { service, deps } = buildService();

    const res: any = await callTool(service, 'get_page', { pageId: 'page-1' });

    expect(deps.pageAccessService.validateCanView).toHaveBeenCalledWith(
      page,
      user,
    );
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0].text).id).toBe('page-1');
  });

  it('get_page hides pages from other workspaces behind "not found"', async () => {
    const { service, deps } = buildService();
    deps.pageRepo.findById.mockResolvedValue({
      ...page,
      workspaceId: 'other-workspace',
    });

    const res: any = await callTool(service, 'get_page', { pageId: 'page-1' });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('Page not found');
    expect(deps.pageAccessService.validateCanView).not.toHaveBeenCalled();
  });

  it('delete_page validates edit access before trashing', async () => {
    const { service, deps } = buildService();
    deps.pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException(),
    );

    const res: any = await callTool(service, 'delete_page', {
      pageId: 'page-1',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.pageService.removePage).not.toHaveBeenCalled();
  });

  it('delete_page goes through pageService so children and audit are handled', async () => {
    const { service, deps } = buildService();

    await callTool(service, 'delete_page', { pageId: 'page-1' });

    expect(deps.pageService.removePage).toHaveBeenCalledWith(
      'page-1',
      'user-1',
      'workspace-1',
    );
    expect(deps.auditService.log).toHaveBeenCalled();
  });

  it('update_page validates edit access', async () => {
    const { service, deps } = buildService();
    deps.pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException(),
    );

    const res: any = await callTool(service, 'update_page', {
      pageId: 'page-1',
      title: 'New',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.pageService.update).not.toHaveBeenCalled();
  });

  it('create_page requires create permission on the target space', async () => {
    const { service, deps } = buildService();
    deps.spaceAbility.createForUser.mockResolvedValue({
      cannot: () => true,
      can: () => false,
    });

    const res: any = await callTool(service, 'create_page', {
      title: 'New',
      spaceId: 'space-1',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.pageService.create).not.toHaveBeenCalled();
  });

  it('create_page requires edit permission on the parent page', async () => {
    const { service, deps } = buildService();
    deps.pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException(),
    );

    const res: any = await callTool(service, 'create_page', {
      title: 'New',
      spaceId: 'space-1',
      parentPageId: 'page-1',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.spaceAbility.createForUser).not.toHaveBeenCalled();
    expect(deps.pageService.create).not.toHaveBeenCalled();
  });

  it('create_base checks the space resolved from the parent page', async () => {
    const { service, deps } = buildService();
    deps.baseService.createBase.mockResolvedValue({ id: 'base-1', title: 'K' });

    await callTool(service, 'create_base', {
      name: 'K',
      parentPageId: 'page-1',
    });

    expect(deps.pageAccessService.validateCanEdit).toHaveBeenCalledWith(
      page,
      user,
    );
    expect(deps.baseService.createBase).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: 'space-1' }),
      'user-1',
      'workspace-1',
    );
  });

  it('base write tools require edit access on the base page', async () => {
    const { service, deps } = buildService({
      baseService: { createRow: jest.fn() },
    });
    deps.pageRepo.findById.mockResolvedValue({ ...page, isBase: true });
    deps.pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException(),
    );

    const res: any = await callTool(service, 'create_base_row', {
      pageId: 'page-1',
      cells: { prop: 'x' },
    });

    expect(res.result.isError).toBe(true);
    expect(deps.baseService.createRow).not.toHaveBeenCalled();
  });

  it('base read tools require view access on the base page', async () => {
    const { service, deps } = buildService({
      baseService: { listRows: jest.fn() },
    });
    deps.pageRepo.findById.mockResolvedValue({ ...page, isBase: true });
    deps.pageAccessService.validateCanView.mockRejectedValue(
      new ForbiddenException(),
    );

    const res: any = await callTool(service, 'list_base_rows', {
      pageId: 'page-1',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.baseService.listRows).not.toHaveBeenCalled();
  });

  it('base tools reject a page that is not a base', async () => {
    const { service, deps } = buildService({
      baseService: { listRows: jest.fn() },
    });
    deps.pageRepo.findById.mockResolvedValue({ ...page, isBase: false });

    const res: any = await callTool(service, 'list_base_rows', {
      pageId: 'page-1',
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('Base not found');
    expect(deps.baseService.listRows).not.toHaveBeenCalled();
  });

  it('base tools scope every call to the caller workspace', async () => {
    const { service, deps } = buildService({
      baseService: { updateRow: jest.fn().mockResolvedValue({ id: 'row-1' }) },
    });
    deps.pageRepo.findById.mockResolvedValue({ ...page, isBase: true });

    await callTool(service, 'update_base_row', {
      pageId: 'page-1',
      rowId: 'row-1',
      cells: { prop: 'x' },
    });

    expect(deps.baseService.updateRow).toHaveBeenCalledWith(
      { pageId: 'page-1', rowId: 'row-1', cells: { prop: 'x' } },
      'user-1',
      'workspace-1',
    );
  });

  it('create_comment converts markdown and requires comment access', async () => {
    const { service, deps } = buildService();
    deps.commentService.create.mockResolvedValue({ id: 'comment-1' });
    deps.pageAccessService.validateCanComment = jest.fn();

    await callTool(service, 'create_comment', {
      pageId: 'page-1',
      content: 'hello **world**',
    });

    expect(deps.pageAccessService.validateCanComment).toHaveBeenCalledWith(
      page,
      user,
      'workspace-1',
    );

    const [, dto] = deps.commentService.create.mock.calls[0];
    const parsed = JSON.parse(dto.content);
    expect(parsed.type).toBe('doc');
  });

  it('comment tools reject a comment from another workspace', async () => {
    const { service, deps } = buildService();
    deps.commentRepo.findById.mockResolvedValue({
      id: 'comment-1',
      pageId: 'page-1',
      workspaceId: 'other-workspace',
    });

    const res: any = await callTool(service, 'get_comment', {
      commentId: 'comment-1',
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('Comment not found');
  });

  it('get_comment rejects a comment on a page the user cannot view', async () => {
    const comment = {
      id: 'comment-1',
      pageId: 'page-1',
      workspaceId: 'workspace-1',
    };
    const { service, deps } = buildService({
      commentRepo: { findById: jest.fn().mockResolvedValue(comment) },
    });
    deps.pageAccessService.validateCanView.mockRejectedValue(
      new ForbiddenException(),
    );

    const response: any = await callTool(service, 'get_comment', {
      commentId: 'comment-1',
    });

    expect(response.result.isError).toBe(true);
  });

  it('delete_comment lets a non-owner through only as space admin', async () => {
    const { service, deps } = buildService();
    deps.pageAccessService.validateCanComment = jest.fn();
    deps.commentRepo.findById.mockResolvedValue({
      id: 'comment-1',
      pageId: 'page-1',
      spaceId: 'space-1',
      workspaceId: 'workspace-1',
      creatorId: 'someone-else',
    });
    deps.spaceAbility.createForUser.mockResolvedValue({ cannot: () => true });

    const res: any = await callTool(service, 'delete_comment', {
      commentId: 'comment-1',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.commentRepo.deleteComment).not.toHaveBeenCalled();
  });

  it('restore_page requires space edit permission', async () => {
    const { service, deps } = buildService();
    deps.pageRepo.findById.mockResolvedValue({
      ...page,
      deletedAt: new Date(),
    });
    deps.pageRepo.restorePage = jest.fn();
    deps.spaceAbility.createForUser.mockResolvedValue({ cannot: () => true });

    const res: any = await callTool(service, 'restore_page', {
      pageId: 'page-1',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.pageRepo.restorePage).not.toHaveBeenCalled();
  });

  it('move_page_to_space requires edit on both spaces', async () => {
    const { service, deps } = buildService();
    deps.pageService.movePageToSpace = jest.fn();
    deps.spaceAbility.createForUser
      .mockResolvedValueOnce({ cannot: () => false })
      .mockResolvedValueOnce({ cannot: () => true });

    const res: any = await callTool(service, 'move_page_to_space', {
      pageId: 'page-1',
      spaceId: 'space-2',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.pageService.movePageToSpace).not.toHaveBeenCalled();
  });

  it('search_attachments drops results outside the user spaces', async () => {
    const { service, deps } = buildService();
    deps.searchAttachmentsService.search.mockResolvedValue({
      items: [
        { id: 'a1', pageId: 'page-1', spaceId: 'space-1' },
        { id: 'a2', pageId: 'page-9', spaceId: 'space-secret' },
      ],
    });
    deps.spaceMemberRepo.getUserSpaceIds.mockResolvedValue(['space-1']);
    deps.pagePermissionRepo.filterAccessiblePageIds.mockResolvedValue([
      'page-1',
    ]);

    const res: any = await callTool(service, 'search_attachments', {
      query: 'report',
    });

    const body = JSON.parse(res.result.content[0].text);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('a1');
  });

  it('search_everything returns every category empty when the user has no space', async () => {
    const { service } = buildService();

    const res: any = await callTool(service, 'search_everything', {
      query: 'qualquer',
    });

    expect(JSON.parse(res.result.content[0].text)).toEqual({
      query: 'qualquer',
      pages: [],
      rows: [],
      comments: [],
      files: [],
    });
  });

  it('search_everything checks membership before sweeping a given space', async () => {
    const { service, deps } = buildService();
    deps.spaceAbility.createForUser.mockResolvedValue({ cannot: () => true });

    const res: any = await callTool(service, 'search_everything', {
      query: 'x',
      spaceId: 'space-9',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.searchService.searchPage).not.toHaveBeenCalled();
  });

  it('upload_attachment requires edit access on the page', async () => {
    const { service, deps } = buildService();
    deps.pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException(),
    );

    const res: any = await callTool(service, 'upload_attachment', {
      pageId: 'page-1',
      fileName: 'a.png',
      contentBase64: Buffer.from('hello').toString('base64'),
    });

    expect(res.result.isError).toBe(true);
    expect(deps.attachmentService.uploadFile).not.toHaveBeenCalled();
  });

  it('upload_attachment rejects payloads over the base64 cap', async () => {
    const { service, deps } = buildService();

    const res: any = await callTool(service, 'upload_attachment', {
      pageId: 'page-1',
      fileName: 'big.bin',
      contentBase64: 'A'.repeat(3 * 1024 * 1024),
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('too large');
    expect(deps.attachmentService.uploadFile).not.toHaveBeenCalled();
  });

  it('upload_attachment strips a data: prefix and needs an extension', async () => {
    const { service, deps } = buildService();
    deps.attachmentService.uploadFile.mockResolvedValue({
      id: 'att-1', fileName: 'a.png', fileSize: 5, mimeType: 'image/png',
    });

    const bad: any = await callTool(service, 'upload_attachment', {
      pageId: 'page-1',
      fileName: 'semextensao',
      contentBase64: Buffer.from('hello').toString('base64'),
    });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('extension');

    const good: any = await callTool(service, 'upload_attachment', {
      pageId: 'page-1',
      fileName: 'a.png',
      contentBase64:
        'data:image/png;base64,' + Buffer.from('hello').toString('base64'),
    });
    expect(good.result.isError).toBeUndefined();
    expect(JSON.parse(good.result.content[0].text).attachmentId).toBe('att-1');
  });

  it('search_semantic drops hits below the similarity floor', async () => {
    const { service, deps } = buildService();
    deps.spaceMemberRepo.getUserSpaceIds.mockResolvedValue(['space-1']);
    // embeddingService.search already applies page-level permissions
    // internally, so the tool only has the similarity floor left to enforce.
    deps.embeddingService.search.mockResolvedValue([
      { pageId: 'page-1', title: 'Perto', similarity: 0.81, excerpt: 'a' },
      { pageId: 'page-2', title: 'Longe', similarity: 0.05, excerpt: 'b' },
    ]);

    const res: any = await callTool(service, 'search_semantic', {
      query: 'como lidamos com cliente insatisfeito',
    });

    const results = JSON.parse(res.result.content[0].text).results;
    expect(results).toHaveLength(1);
    expect(results[0].pageId).toBe('page-1');
  });

  it('search_semantic passes the caller through to the embedding search', async () => {
    const { service, deps } = buildService();
    deps.spaceMemberRepo.getUserSpaceIds.mockResolvedValue(['space-1']);
    // Page-level restrictions are enforced inside embeddingService.search
    // itself now, so a restricted page never reaches the tool as a hit.
    deps.embeddingService.search.mockResolvedValue([
      { pageId: 'page-1', title: 'Livre', similarity: 0.9, excerpt: 'a' },
    ]);

    const res: any = await callTool(service, 'search_semantic', { query: 'x' });

    expect(deps.embeddingService.search).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id }),
    );
    const results = JSON.parse(res.result.content[0].text).results;
    expect(results.map((r: any) => r.pageId)).toEqual(['page-1']);
  });

  it('search_semantic says so when nothing has been embedded yet', async () => {
    const { service, deps } = buildService();
    deps.spaceMemberRepo.getUserSpaceIds.mockResolvedValue(['space-1']);
    deps.embeddingService.search.mockResolvedValue([]);

    const res: any = await callTool(service, 'search_semantic', { query: 'x' });

    expect(JSON.parse(res.result.content[0].text).note).toContain(
      'reindex_embeddings',
    );
  });

  it('exposes the page and base tool surface', async () => {
    const { service } = buildService();

    const res: any = await service.handleRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      user,
      workspace,
    );

    const names = res.result.tools.map((tool: any) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'get_page',
        'create_base_row',
        'create_comment',
        'use_template',
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('search_workspace delegates to the full-text search scoped to the user', async () => {
    const { service, deps } = buildService();
    deps.searchService.searchPage.mockResolvedValue({
      items: [
        {
          id: 'page-1',
          title: 'Page',
          slugId: 'abc123',
          space: { id: 'space-1', name: 'Space' },
          highlight: 'a <b>match</b>',
        },
      ],
    });

    const res: any = await callTool(service, 'search_workspace', {
      query: 'match',
    });

    expect(deps.searchService.searchPage).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'match' }),
      { userId: 'user-1', workspaceId: 'workspace-1' },
    );
    expect(JSON.parse(res.result.content[0].text).results[0]).toEqual(
      expect.objectContaining({ spaceId: 'space-1', highlight: 'a <b>match</b>' }),
    );
  });

  it('search_workspace checks membership when a spaceId is given', async () => {
    const { service, deps } = buildService();
    deps.spaceAbility.createForUser.mockResolvedValue({ cannot: () => true });

    const res: any = await callTool(service, 'search_workspace', {
      query: 'match',
      spaceId: 'space-9',
    });

    expect(res.result.isError).toBe(true);
    expect(deps.searchService.searchPage).not.toHaveBeenCalled();
  });

  it('get_page returns markdown by default and raw json on request', async () => {
    const { service, deps } = buildService();
    deps.pageRepo.findById.mockResolvedValue({
      ...page,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'hello' }],
          },
        ],
      },
    });

    const asMarkdown: any = await callTool(service, 'get_page', {
      pageId: 'page-1',
    });
    const markdownBody = JSON.parse(asMarkdown.result.content[0].text);

    expect(markdownBody.format).toBe('markdown');
    expect(typeof markdownBody.content).toBe('string');
    expect(markdownBody.content).toContain('hello');

    const asJson: any = await callTool(service, 'get_page', {
      pageId: 'page-1',
      format: 'json',
    });
    const jsonBody = JSON.parse(asJson.result.content[0].text);

    expect(jsonBody.content.type).toBe('doc');
  });

  it('list_spaces returns nothing when the user belongs to no space', async () => {
    const { service } = buildService();

    const res: any = await callTool(service, 'list_spaces', {});

    expect(JSON.parse(res.result.content[0].text)).toEqual({ spaces: [] });
  });
});
