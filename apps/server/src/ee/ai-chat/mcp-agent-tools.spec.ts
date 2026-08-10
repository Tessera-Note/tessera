import { AGENT_TOOL_POLICY, buildMcpAgentTools } from './mcp-agent-tools';

/**
 * Агент чата берет инструменты у MCP, а не заводит свои: те уже проходят
 * проверку прав и пишут в журнал аудита. Мост обязан отдавать ровно то, что
 * разрешено степенью риска, и ничего сверх того.
 */
function bridge(names: string[], run?: jest.Mock) {
  return {
    listAgentTools: () =>
      names.map((name) => ({
        name,
        description: `описание ${name}`,
        inputSchema: {
          type: 'object',
          properties: { pageId: { type: 'string' } },
        },
      })),
    runAgentTool: run ?? jest.fn(async () => ({ ok: true })),
  };
}

const USER = { id: 'u-1' } as any;
const WORKSPACE = { id: 'ws-1' } as any;

describe('buildMcpAgentTools', () => {
  it('отдает разрешенные степенью риска инструменты', () => {
    const tools = buildMcpAgentTools({
      mcp: bridge(['list_pages', 'delete_page']),
      user: USER,
      workspace: WORKSPACE,
      allow: ['read', 'write'],
    });

    expect(Object.keys(tools)).toEqual(['list_pages']);
  });

  /**
   * Инструмент, который агент видит, но выполнить не может, хуже
   * отсутствующего: он тратит шаг и заканчивается отказом.
   */
  it('необратимые не отдаются, пока они не разрешены', () => {
    const tools = buildMcpAgentTools({
      mcp: bridge(['delete_page', 'move_page']),
      user: USER,
      workspace: WORKSPACE,
      allow: ['read', 'write'],
    });

    expect(Object.keys(tools)).toEqual([]);
  });

  it('с разрешением необратимые появляются', () => {
    const tools = buildMcpAgentTools({
      mcp: bridge(['delete_page']),
      user: USER,
      workspace: WORKSPACE,
      allow: ['read', 'write', 'destructive'],
    });

    expect(Object.keys(tools)).toEqual(['delete_page']);
  });

  /** Инструмент вне списка не появляется даже при полном разрешении. */
  it('неописанный инструмент не проходит', () => {
    const tools = buildMcpAgentTools({
      mcp: bridge(['reindex_embeddings', 'delete_base']),
      user: USER,
      workspace: WORKSPACE,
      allow: ['read', 'write', 'destructive'],
    });

    expect(Object.keys(tools)).toEqual([]);
  });

  it('исполнение идет через MCP с контекстом человека', async () => {
    const run = jest.fn(async () => ({ pages: [] }));
    const tools: any = buildMcpAgentTools({
      mcp: bridge(['list_pages'], run),
      user: USER,
      workspace: WORKSPACE,
      allow: ['read'],
    });

    await tools.list_pages.execute({ spaceId: 's-1' });

    expect(run).toHaveBeenCalledWith(
      'list_pages',
      { spaceId: 's-1' },
      USER,
      WORKSPACE,
    );
  });

  /** Отказ инструмента не должен ронять разговор. */
  it('отказ возвращается агенту причиной, а не исключением', async () => {
    const run = jest.fn(async () => {
      throw new Error('Page not found');
    });
    const tools: any = buildMcpAgentTools({
      mcp: bridge(['get_page'], run),
      user: USER,
      workspace: WORKSPACE,
      allow: ['read'],
    });

    await expect(tools.get_page.execute({ pageId: 'x' })).resolves.toEqual({
      error: 'Page not found',
    });
  });

  it('схема берется у MCP, а не переописывается', () => {
    const tools: any = buildMcpAgentTools({
      mcp: bridge(['list_pages']),
      user: USER,
      workspace: WORKSPACE,
      allow: ['read'],
    });

    expect(tools.list_pages.inputSchema.jsonSchema).toMatchObject({
      type: 'object',
      properties: { pageId: { type: 'string' } },
    });
  });
});

describe('AGENT_TOOL_POLICY', () => {
  /**
   * Обзор структуры и есть то, чего агенту не хватало: без списка страниц он
   * отвечал, что поиск ничего не вернул, хотя страницы в вики были.
   */
  it('обзор структуры доступен без подтверждения', () => {
    for (const name of ['list_spaces', 'list_pages', 'get_page']) {
      expect(AGENT_TOOL_POLICY[name]).toBe('read');
    }
  });

  it('перенос и удаление отнесены к необратимым', () => {
    for (const name of ['move_page', 'move_page_to_space', 'delete_page']) {
      expect(AGENT_TOOL_POLICY[name]).toBe('destructive');
    }
  });

  /** Ни один инструмент не должен остаться без степени риска. */
  it('у каждого описанного инструмента задана степень', () => {
    const missing = Object.entries(AGENT_TOOL_POLICY).filter(
      ([, risk]) => !['read', 'write', 'destructive'].includes(risk),
    );

    expect(missing).toEqual([]);
  });
});

/**
 * Необратимое действие агент не выполняет сам: он записывает намерение, а
 * исполняется оно только после явного согласия человека.
 */
describe('buildMcpAgentTools, режим плана', () => {
  it('необратимый шаг записывается, а не выполняется', async () => {
    const run = jest.fn();
    const plan: any[] = [];
    const tools: any = buildMcpAgentTools({
      mcp: bridge(['delete_page'], run),
      user: USER,
      workspace: WORKSPACE,
      allow: ['read', 'write', 'destructive'],
      plan,
    });

    const answer = await tools.delete_page.execute({ pageId: 'p-1' });

    expect(run).not.toHaveBeenCalled();
    expect(plan).toEqual([{ tool: 'delete_page', args: { pageId: 'p-1' } }]);
    expect(answer).toMatchObject({ status: 'planned' });
  });

  /** Обратимые действия план не задерживает: спрашивать о них незачем. */
  it('обратимый шаг выполняется и в режиме плана', async () => {
    const run = jest.fn(async () => ({ ok: true }));
    const plan: any[] = [];
    const tools: any = buildMcpAgentTools({
      mcp: bridge(['add_page_labels'], run),
      user: USER,
      workspace: WORKSPACE,
      allow: ['read', 'write', 'destructive'],
      plan,
    });

    await tools.add_page_labels.execute({ pageId: 'p-1' });

    expect(run).toHaveBeenCalled();
    expect(plan).toEqual([]);
  });

  /**
   * Исполнение подтвержденного плана идет тем же путем, без `plan`: иначе
   * согласие человека снова превратилось бы в запись намерения.
   */
  it('без плана необратимый шаг выполняется', async () => {
    const run = jest.fn(async () => ({ ok: true }));
    const tools: any = buildMcpAgentTools({
      mcp: bridge(['delete_page'], run),
      user: USER,
      workspace: WORKSPACE,
      allow: ['destructive'],
    });

    await tools.delete_page.execute({ pageId: 'p-1' });

    expect(run).toHaveBeenCalledWith(
      'delete_page',
      { pageId: 'p-1' },
      USER,
      WORKSPACE,
    );
  });

  it('несколько шагов копятся в порядке вызова', async () => {
    const plan: any[] = [];
    const tools: any = buildMcpAgentTools({
      mcp: bridge(['move_page', 'delete_page']),
      user: USER,
      workspace: WORKSPACE,
      allow: ['destructive'],
      plan,
    });

    await tools.move_page.execute({ pageId: 'p-1' });
    await tools.delete_page.execute({ pageId: 'p-2' });

    expect(plan.map((step) => step.tool)).toEqual(['move_page', 'delete_page']);
  });
});

/**
 * Решение по плану принимается один раз и переживает уход человека: план
 * хранится на сообщении, а не в памяти процесса.
 *
 * Расхождение состояния между составлением и согласием разрешается остановкой
 * на первом отказе. Человек соглашался с планом целиком, и продолжение после
 * расхождения сделало бы то, чего он не одобрял: в плане «перенести А под Б,
 * затем удалить Б» пропуск первого шага и исполнение второго потеряли бы А.
 */
describe('исполнение подтвержденного плана', () => {
  function service(runs: Array<() => Promise<unknown>>) {
    const { AiChatService } = require('./ai-chat.service');
    const svc = Object.create(AiChatService.prototype);
    const updates: any[] = [];

    // Захват плана идет условным обновлением с `returning`, поэтому заглушка
    // отвечает строкой и на него: иначе захват считался бы неудачным.
    const chain = (row: any): any => ({
      selectAll: () => chain(row),
      select: () => chain(row),
      set: (v: any) => {
        updates.push(v);
        return chain(row);
      },
      where: () => chain(row),
      returning: () => chain({ id: 'm-1' }),
      execute: async () => [],
      executeTakeFirst: async () => row,
    });

    const rows = [
      { id: 'm-1', chatId: 'c-1', metadata: { pendingPlan: PLAN } },
      { creatorId: 'u-1' },
      { id: 'ws-1' },
    ];
    let i = 0;

    svc.db = {
      selectFrom: () => chain(rows[i++]),
      updateTable: () => chain(undefined),
    };

    let call = 0;
    svc.mcpService = {
      runAgentTool: jest.fn(async () => {
        const next = runs[call++];
        return next ? next() : undefined;
      }),
    };

    return { svc, updates };
  }

  const PLAN = [
    { tool: 'move_page', args: { pageId: 'a' } },
    { tool: 'delete_page', args: { pageId: 'b' } },
  ];

  it('исправный план исполняется целиком', async () => {
    const { svc, updates } = service([async () => ({}), async () => ({})]);

    const out = await svc.resolvePlan('m-1', 'confirm', { id: 'u-1' }, 'ws-1');

    expect(out.status).toBe('applied');
    expect(out.results).toHaveLength(2);
    expect(updates[updates.length - 1].metadata.planStatus).toBe('applied');
  });

  it('отказ шага останавливает план, следующий не исполняется', async () => {
    const { svc } = service([
      async () => {
        throw new Error('Page not found');
      },
      async () => ({}),
    ]);

    const out = await svc.resolvePlan('m-1', 'confirm', { id: 'u-1' }, 'ws-1');

    expect(out.status).toBe('failed');
    expect(out.results).toEqual([
      { tool: 'move_page', ok: false, error: 'Page not found' },
    ]);
    expect(svc.mcpService.runAgentTool).toHaveBeenCalledTimes(1);
  });

  it('отклонение ничего не исполняет и записывается', async () => {
    const { svc, updates } = service([]);

    const out = await svc.resolvePlan('m-1', 'reject', { id: 'u-1' }, 'ws-1');

    expect(out.status).toBe('rejected');
    expect(svc.mcpService.runAgentTool).not.toHaveBeenCalled();
    expect(updates[updates.length - 1].metadata.planStatus).toBe('rejected');
  });
});

/**
 * План лежит в столбце JSON. Исполнение обязано опираться на разрешительный
 * список, а не на то, что в этом столбце оказалось.
 */
describe('исполнение сверяет имя инструмента заново', () => {
  it('инструмент вне списка не исполняется', () => {
    expect(AGENT_TOOL_POLICY['reindex_embeddings']).toBeUndefined();
    expect(AGENT_TOOL_POLICY['delete_base']).toBeUndefined();
  });

  it('обратимый инструмент в плане не место', () => {
    expect(AGENT_TOOL_POLICY['add_page_labels']).not.toBe('destructive');
    expect(AGENT_TOOL_POLICY['list_pages']).not.toBe('destructive');
  });
});
