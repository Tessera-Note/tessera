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
