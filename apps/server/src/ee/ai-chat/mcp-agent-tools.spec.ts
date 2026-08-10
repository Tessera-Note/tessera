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
