jest.mock('ai', () => ({
  streamText: jest.fn(),
  generateText: jest.fn(),
  // Инструменты собираются на каждом вызове, поэтому подмена модуля обязана
  // отдавать и их сборщик: без него служба падает до первого запроса.
  tool: (definition: unknown) => definition,
  stepCountIs: (count: number) => count,
}));

import { ForbiddenException } from '@nestjs/common';
import { streamText } from 'ai';
import { AiChatService } from './ai-chat.service';
import { User } from '@tessera/db/types/entity.types';

const WORKSPACE = 'workspace-1';
const OTHER_WORKSPACE = 'workspace-2';
const PAGE_ID = '018f8b3c-0000-7000-8000-000000000001';

const user = { id: 'user-1', locale: 'pt-BR' } as User;

/**
 * Правка приходила разметкой в тексте ответа, которую сервер разбирал после
 * завершения потока. Теперь ее делает инструмент, и проверяется тот же вход,
 * которым пользуется модель.
 */
function editCommand(page = PAGE_ID, operation = 'append') {
  return { page, content: 'novo conteúdo', operation };
}

function titleCommand(page = PAGE_ID) {
  return { page, title: 'Novo título' };
}

type Mocks = {
  pageService: { updatePageContent: jest.Mock };
  pageRepo: { findById: jest.Mock; updatePage: jest.Mock };
  pageAccessService: { validateCanEdit: jest.Mock };
  environmentService: { getAppName: jest.Mock };
};

function build(overrides: {
  page?: unknown;
  findByIdThrows?: boolean;
  canEdit?: boolean;
}) {
  const mocks: Mocks = {
    pageService: { updatePageContent: jest.fn().mockResolvedValue(undefined) },
    pageRepo: {
      findById: overrides.findByIdThrows
        ? jest
            .fn()
            .mockRejectedValue(new Error('invalid input syntax for uuid'))
        : jest.fn().mockResolvedValue(overrides.page),
      updatePage: jest.fn().mockResolvedValue(undefined),
    },
    pageAccessService: {
      validateCanEdit:
        overrides.canEdit === false
          ? jest.fn().mockRejectedValue(new ForbiddenException())
          : jest.fn().mockResolvedValue({ hasRestriction: false }),
    },
    environmentService: { getAppName: jest.fn().mockReturnValue('Tessera') },
  };

  const service = new AiChatService(
    {} as any,
    {} as any,
    // AgentImageService: перенос картинок разбора команд правки не касается,
    // содержимое отдается как есть.
    { localizeImages: async (markdown: string) => markdown } as any,
    mocks.pageService as any,
    mocks.pageRepo as any,
    mocks.pageAccessService as any,
    {} as any,
    // WebSearchService: разбор команд правки его не касается.
    {} as any,
    {} as any,
    mocks.environmentService as any,
    {} as any,
  );

  return { service, mocks };
}

async function run(service: AiChatService, command: any) {
  return [await (service as any).applyPageEdit(command, user, WORKSPACE)];
}

async function runTitle(service: AiChatService, command: any) {
  return [await (service as any).applyTitleChange(command, user, WORKSPACE)];
}

describe('AiChatService edit command authorization', () => {
  const allowedPage = {
    id: PAGE_ID,
    workspaceId: WORKSPACE,
    spaceId: 'space-1',
    deletedAt: null,
  };

  it('applies an edit the user is allowed to make', async () => {
    const { service, mocks } = build({ page: allowedPage });

    const outcomes = await run(service, editCommand());

    expect(outcomes).toEqual([
      { pageId: PAGE_ID, action: 'content', applied: true },
    ]);
    expect(mocks.pageService.updatePageContent).toHaveBeenCalledWith(
      PAGE_ID,
      'novo conteúdo',
      'append',
      'markdown',
      user,
    );
  });

  it('refuses a page the user cannot edit and does not touch it', async () => {
    const { service, mocks } = build({ page: allowedPage, canEdit: false });

    const outcomes = await run(service, editCommand());

    expect(outcomes[0].applied).toBe(false);
    expect(outcomes[0].reason).toMatch(/permission/i);
    expect(mocks.pageService.updatePageContent).not.toHaveBeenCalled();
  });

  it('refuses a page belonging to another workspace', async () => {
    const { service, mocks } = build({
      page: { ...allowedPage, workspaceId: OTHER_WORKSPACE },
    });

    const outcomes = await run(service, editCommand());

    expect(outcomes[0].applied).toBe(false);
    expect(mocks.pageService.updatePageContent).not.toHaveBeenCalled();
    // Cross-workspace targets are rejected before any permission lookup.
    expect(mocks.pageAccessService.validateCanEdit).not.toHaveBeenCalled();
  });

  it('refuses a deleted page', async () => {
    const { service, mocks } = build({
      page: { ...allowedPage, deletedAt: new Date() },
    });

    const outcomes = await run(service, editCommand());

    expect(outcomes[0].applied).toBe(false);
    expect(mocks.pageService.updatePageContent).not.toHaveBeenCalled();
  });

  it('refuses a page that does not exist', async () => {
    const { service, mocks } = build({ page: undefined });

    const outcomes = await run(service, editCommand());

    expect(outcomes[0]).toEqual({
      pageId: PAGE_ID,
      action: 'content',
      applied: false,
      reason: 'Page not found',
      refusal: 'not-found',
    });
    expect(mocks.pageService.updatePageContent).not.toHaveBeenCalled();
  });

  it('survives a malformed page id instead of throwing', async () => {
    const { service, mocks } = build({ findByIdThrows: true });

    const outcomes = await run(service, editCommand('not-a-uuid'));

    expect(outcomes[0].applied).toBe(false);
    expect(mocks.pageService.updatePageContent).not.toHaveBeenCalled();
  });

  it('guards title updates with the same check', async () => {
    const { service, mocks } = build({ page: allowedPage, canEdit: false });

    const outcomes = await runTitle(service, titleCommand());

    expect(outcomes).toEqual([
      {
        pageId: PAGE_ID,
        action: 'title',
        applied: false,
        reason: 'You do not have permission to edit this page',
        refusal: 'forbidden',
      },
    ]);
    expect(mocks.pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('renames a page when allowed', async () => {
    const { service, mocks } = build({ page: allowedPage });

    const outcomes = await runTitle(service, titleCommand());

    expect(outcomes[0].applied).toBe(true);
    expect(mocks.pageRepo.updatePage).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Novo título' }),
      PAGE_ID,
    );
  });

  /**
   * Разбора разметки больше нет: вход инструмента проверяется схемой до
   * вызова. Проверяется то, что осталось на стороне службы, — ссылка на
   * страницу, которую нельзя привести к идентификатору.
   */
  it('survives an unusable page reference instead of throwing', async () => {
    const { service, mocks } = build({ page: allowedPage });

    const outcomes = await run(service, editCommand('   '));

    expect(outcomes[0].applied).toBe(false);
    expect(mocks.pageService.updatePageContent).not.toHaveBeenCalled();
  });

  it('reports content and title separately', async () => {
    const { service } = build({ page: allowedPage });

    const outcomes = [
      ...(await run(service, editCommand())),
      ...(await runTitle(service, titleCommand())),
    ];

    expect(outcomes.map((o: any) => o.action)).toEqual(['content', 'title']);
  });
});

describe('AiChatService system prompt', () => {
  function prompt(locale?: string) {
    const { service } = build({});
    return (service as any).buildSystemPrompt(
      '',
      undefined,
      locale ?? 'Brazilian Portuguese (pt-BR)',
    );
  }

  it('identifies itself as the wiki, not Docmost', () => {
    const text = prompt();
    expect(text).toContain('Tessera');
    expect(text).not.toContain('Docmost');
  });

  it('states the language to write in', () => {
    expect(prompt()).toContain('Brazilian Portuguese (pt-BR)');
    expect(prompt('Japanese')).toContain('Japanese');
  });

  it('warns the model off destructive replaces', () => {
    expect(prompt()).toMatch(/never use "replace"/i);
  });
});

describe('AiChatService.textSearchPages permission filtering', () => {
  function buildQuery(rows: unknown[]) {
    const query: any = {
      select: jest.fn(() => query),
      where: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      limit: jest.fn(() => query),
      execute: jest.fn().mockResolvedValue(rows),
    };
    return query;
  }

  function buildService(rows: unknown[], accessiblePageIds: string[]) {
    const query = buildQuery(rows);
    const db = { selectFrom: jest.fn(() => query) };
    const pagePermissionRepo = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(accessiblePageIds),
    };

    const service = new AiChatService(
      db as any,
      {} as any,
      // AgentImageService: поиск по вики его не касается.
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      // WebSearchService: текстовый поиск по вики его не касается.
      {} as any,
      {} as any,
      { getAppName: jest.fn() } as any,
      pagePermissionRepo as any,
    );

    return { service, pagePermissionRepo, query };
  }

  it('drops pages the user cannot read from the full-text fallback', async () => {
    const rows = [
      { id: 'page-a', title: 'A', textContent: 'alpha text' },
      { id: 'page-b', title: 'B', textContent: 'beta text' },
    ];
    const { service, pagePermissionRepo } = buildService(rows, ['page-a']);

    const result = await (service as any).textSearchPages({
      query: 'alpha search term',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceIds: ['space-1'],
      exclude: new Set<string>(),
    });

    // If the permission filter were removed, both rows would survive and this
    // would equal ['page-a', 'page-b'] instead.
    expect(result.map((r: any) => r.id)).toEqual(['page-a']);
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-a', 'page-b'],
      userId: 'user-1',
    });
  });

  it('excludes already-in-context pages before checking permissions', async () => {
    const rows = [
      { id: 'page-a', title: 'A', textContent: 'alpha text' },
      { id: 'page-b', title: 'B', textContent: 'beta text' },
    ];
    const { service, pagePermissionRepo } = buildService(rows, [
      'page-a',
      'page-b',
    ]);

    await (service as any).textSearchPages({
      query: 'alpha search term',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceIds: ['space-1'],
      exclude: new Set(['page-b']),
    });

    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-a'],
      userId: 'user-1',
    });
  });
});

describe('AiChatService.sendMessage mentioned-page authorization', () => {
  const CHAT_ID = 'chat-1';
  const WORKSPACE_ID = 'workspace-1';
  const chatUser = { id: 'user-1', locale: 'pt-BR' } as User;

  // A generic Kysely-style chainable query builder: every fluent method
  // returns itself, and the terminal executor resolves to a fixed value.
  function makeQuery(result: unknown) {
    const query: any = {};
    [
      'selectAll',
      'select',
      'where',
      'orderBy',
      'limit',
      'groupBy',
      'innerJoin',
      'values',
      'returning',
      'set',
    ].forEach((fn) => {
      query[fn] = jest.fn(() => query);
    });
    query.execute = jest.fn().mockResolvedValue(result);
    query.executeTakeFirst = jest.fn().mockResolvedValue(result);
    query.executeTakeFirstOrThrow = jest.fn().mockResolvedValue(result);
    return query;
  }

  function buildSendMessageService(opts: {
    mentionedPages: Array<{
      id: string;
      spaceId: string;
      title: string;
      content: string;
    }>;
    restrictedPageIds: Set<string>;
  }) {
    // Order matters: sendMessage issues selectFrom() in this sequence for the
    // scenario under test (existing chat, mentioned pages, no context page,
    // no space membership so retrieval short-circuits before touching the db
    // again).
    const selectFromQueue = [
      makeQuery({
        id: CHAT_ID,
        workspaceId: WORKSPACE_ID,
        creatorId: chatUser.id,
        title: 'Existing chat', // truthy so autoGenerateTitle is skipped
        deletedAt: null,
      }), // chat ownership check
      makeQuery([
        { role: 'user', content: 'previous message' },
        { role: 'assistant', content: 'previous reply' },
      ]), // conversation history
      makeQuery(opts.mentionedPages), // mentioned pages lookup
    ];

    const insertIntoQueue = [
      makeQuery(undefined), // save user message
      makeQuery({ id: 'assistant-msg-1' }), // save assistant message
    ];

    const db = {
      selectFrom: jest.fn(() => selectFromQueue.shift()),
      insertInto: jest.fn(() => insertIntoQueue.shift()),
      updateTable: jest.fn(() => makeQuery(undefined)),
    };

    const providerFactory = {
      isConfigured: jest.fn().mockResolvedValue(true),
      getChatModel: jest.fn().mockResolvedValue('fake-model'),
      getCompletionModel: jest.fn().mockResolvedValue('fake-model'),
    };

    const pageAccessService = {
      validateCanView: jest.fn(async (page: { id: string }) => {
        if (opts.restrictedPageIds.has(page.id)) {
          throw new ForbiddenException();
        }
      }),
    };

    const spaceMemberRepo = {
      // Empty membership makes retrieveWikiContext return immediately
      // without issuing further db/embedding calls, keeping this test
      // focused on the mentioned-pages path.
      getUserSpaceIds: jest.fn().mockResolvedValue([]),
    };

    const environmentService = {
      getAppName: jest.fn().mockReturnValue('Tessera'),
    };

    const service = new AiChatService(
      db as any,
      providerFactory as any,
      // AgentImageService: этому пути перенос картинок не нужен.
      {} as any,
      {} as any, // pageService
      {} as any, // pageRepo
      pageAccessService as any,
      spaceMemberRepo as any,
      // WebSearchService: запрос без признаков свежести поиска не запускает.
      { isConfigured: jest.fn().mockResolvedValue(false) } as any,
      {} as any, // embeddingService (unreached: no space membership)
      environmentService as any,
      {} as any, // pagePermissionRepo (unreached: retrieval short-circuits)
    );

    return { service, db };
  }

  async function drain(service: AiChatService, params: any) {
    const events: unknown[] = [];
    for await (const event of service.sendMessage(
      params,
      chatUser,
      WORKSPACE_ID,
    )) {
      events.push(event);
    }
    return events;
  }

  it('keeps a restricted mentioned page out of the prompt sent to the model', async () => {
    const accessiblePage = {
      id: 'page-a',
      spaceId: 'space-1',
      title: 'Alpha Doc',
      content: 'ALPHA_ACCESSIBLE_CONTENT',
    };
    const restrictedPage = {
      id: 'page-b',
      spaceId: 'space-2',
      title: 'Beta Doc',
      content: 'BETA_RESTRICTED_CONTENT',
    };

    const { service } = buildSendMessageService({
      mentionedPages: [accessiblePage, restrictedPage],
      restrictedPageIds: new Set(['page-b']),
    });

    (streamText as jest.Mock).mockReturnValue({
      fullStream: (async function* () {})(),
    });

    await drain(service, {
      chatId: CHAT_ID,
      content: 'What do the mentioned docs say?',
      mentionedPageIds: ['page-a', 'page-b'],
    });

    expect(streamText).toHaveBeenCalledTimes(1);
    const call = (streamText as jest.Mock).mock.calls[0][0];

    // The system prompt is where mentioned-page content is injected. If the
    // call-site filtering in sendMessage were removed (i.e. the raw db rows
    // were used instead of filterViewablePages(mentioned, user)), the
    // restricted page's content would leak in here.
    expect(call.system).toContain('ALPHA_ACCESSIBLE_CONTENT');
    expect(call.system).not.toContain('BETA_RESTRICTED_CONTENT');
  });
});
