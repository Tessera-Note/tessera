import { EmbeddingProcessor } from './embedding.processor';
import { QueueJob } from '../../integrations/queue/constants';
import { EmbeddingService } from './embedding.service';

/**
 * Задачи уровня рабочего пространства приходят без `pageIds`. Разбор
 * начинался с выхода по пустому списку, и обе такие задачи молча уходили в
 * никуда: администратору сообщалось о поставленной переиндексации, которой не
 * происходило.
 */
function build(over: Partial<any> = {}) {
  const embeddingService: any = {
    isConfigured: jest.fn(async () => true),
    indexWorkspace: jest.fn(async () => ({ indexed: 3, failed: 0 })),
    removeWorkspace: jest.fn(async () => 7),
    indexPage: jest.fn(async () => ({ chunks: 2 })),
    removePage: jest.fn(async () => {}),
    removeSpace: jest.fn(async () => 5),
    moveToSpace: jest.fn(async () => 4),
    ...over,
  };

  const processor = new EmbeddingProcessor(embeddingService);
  jest.spyOn((processor as any).logger, 'debug').mockImplementation(() => {});
  jest.spyOn((processor as any).logger, 'log').mockImplementation(() => {});
  jest.spyOn((processor as any).logger, 'warn').mockImplementation(() => {});

  return { processor, embeddingService };
}

const job = (name: string, data: any) => ({ name, data }) as any;

describe('EmbeddingProcessor, задачи рабочего пространства', () => {
  it('переиндексация запускается, а не отбрасывается по пустому pageIds', async () => {
    const { processor, embeddingService } = build();

    await processor.process(
      job(QueueJob.WORKSPACE_CREATE_EMBEDDINGS, { workspaceId: 'ws-1' }),
    );

    expect(embeddingService.indexWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('без настроенного провайдера переиндексация не запускается', async () => {
    const { processor, embeddingService } = build({
      isConfigured: jest.fn(async () => false),
    });

    await processor.process(
      job(QueueJob.WORKSPACE_CREATE_EMBEDDINGS, { workspaceId: 'ws-1' }),
    );

    expect(embeddingService.indexWorkspace).not.toHaveBeenCalled();
  });

  it('снятие эмбеддингов пространства выполняется', async () => {
    const { processor, embeddingService } = build();

    await processor.process(
      job(QueueJob.WORKSPACE_DELETE_EMBEDDINGS, { workspaceId: 'ws-1' }),
    );

    expect(embeddingService.removeWorkspace).toHaveBeenCalledWith('ws-1');
  });

  // Снятие обязано работать и без ключа: иначе выключение поиска оставляло бы
  // векторы навсегда.
  it('снятие не спрашивает провайдера', async () => {
    const { processor, embeddingService } = build();

    await processor.process(
      job(QueueJob.WORKSPACE_DELETE_EMBEDDINGS, { workspaceId: 'ws-1' }),
    );

    expect(embeddingService.isConfigured).not.toHaveBeenCalled();
  });

  it('задача без рабочего пространства ничего не делает', async () => {
    const { processor, embeddingService } = build();

    await processor.process(job(QueueJob.WORKSPACE_CREATE_EMBEDDINGS, {}));
    await processor.process(job(QueueJob.WORKSPACE_DELETE_EMBEDDINGS, {}));

    expect(embeddingService.indexWorkspace).not.toHaveBeenCalled();
    expect(embeddingService.removeWorkspace).not.toHaveBeenCalled();
  });

  it('удаление пространства снимает его векторы', async () => {
    const { processor, embeddingService } = build();

    await processor.process(job(QueueJob.SPACE_DELETED, { spaceId: 'sp-1' }));

    expect(embeddingService.removeSpace).toHaveBeenCalledWith('sp-1');
  });

  it('удаление рабочего пространства снимает его векторы', async () => {
    const { processor, embeddingService } = build();

    await processor.process(
      job(QueueJob.WORKSPACE_DELETED, { workspaceId: 'ws-1' }),
    );

    expect(embeddingService.removeWorkspace).toHaveBeenCalledWith('ws-1');
  });

  /**
   * Копия пространства в строке вектора обязана ехать вместе со страницей:
   * по ней фильтруется выдача, а права страницы без собственных ограничений
   * доверяются пространству.
   */
  it('перенос страницы переносит и строки векторов', async () => {
    const { processor, embeddingService } = build();

    await processor.process(
      job(QueueJob.PAGE_MOVED_TO_SPACE, {
        pageIds: ['p-1', 'p-2'],
        spaceId: 'sp-new',
        workspaceId: 'ws-1',
      }),
    );

    expect(embeddingService.moveToSpace).toHaveBeenCalledWith(
      ['p-1', 'p-2'],
      'sp-new',
    );
  });

  it('перенос без пространства пересобирает строки, а не оставляет их', async () => {
    const { processor, embeddingService } = build();

    await processor.process(
      job(QueueJob.PAGE_MOVED_TO_SPACE, {
        pageIds: ['p-1'],
        workspaceId: 'ws-1',
      }),
    );

    expect(embeddingService.moveToSpace).not.toHaveBeenCalled();
    expect(embeddingService.removePage).toHaveBeenCalledWith('p-1');
  });

  it('постраничные задачи по-прежнему выходят на пустом списке', async () => {
    const { processor, embeddingService } = build();

    await processor.process(
      job(QueueJob.PAGE_UPDATED, { workspaceId: 'ws-1', pageIds: [] }),
    );

    expect(embeddingService.indexPage).not.toHaveBeenCalled();
  });

  it('постраничная индексация работает как прежде', async () => {
    const { processor, embeddingService } = build();

    await processor.process(
      job(QueueJob.PAGE_UPDATED, {
        workspaceId: 'ws-1',
        pageIds: ['p-1', 'p-2'],
      }),
    );

    expect(embeddingService.indexPage).toHaveBeenCalledTimes(2);
  });
});

/**
 * Обход идет по всем страницам, а не по «непроиндексированным»: переиндексация
 * запускается сменой провайдера или модели, когда прежние векторы
 * недействительны целиком. Заодно это снимает ловушку бесконечного цикла —
 * страница без текста строк не получает и осталась бы «непроиндексированной»
 * навсегда.
 */
function buildService(batches: string[][]) {
  const service = Object.create(EmbeddingService.prototype) as any;
  const calls: Array<string | null> = [];
  let batch = 0;

  const wheres: any[][] = [];
  const query: any = {
    select: () => query,
    where: (...args: any[]) => {
      wheres.push(args);
      return query;
    },
    $if: (condition: boolean, cb: (qb: any) => any) =>
      condition ? cb(query) : query,
    orderBy: () => query,
    limit: () => query,
    execute: async () => (batches[batch++] ?? []).map((id) => ({ id })),
  };

  service.db = { selectFrom: () => query };
  service.logger = { warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
  // Настройки разрешаются один раз на прогон, обход к ним не обращается.
  service.embeddingRun = jest.fn(async () => ({
    identity: {
      driver: 'openrouter',
      baseUrl: null,
      modelName: 'openai/text-embedding-3-small',
    },
    model: {},
    providerOptions: undefined,
  }));
  service.indexPage = jest.fn(async (id: string) => {
    calls.push(id);
    if (id === 'плохая') throw new Error('модель отказала');
    return { chunks: 1 };
  });

  return { service, calls, wheres };
}

describe('EmbeddingService.indexWorkspace', () => {
  it('обходит все страницы постранично и останавливается на пустой выдаче', async () => {
    const { service, calls } = buildService([['p-1', 'p-2'], ['p-3'], []]);

    const result = await service.indexWorkspace('ws-1');

    expect(calls).toEqual(['p-1', 'p-2', 'p-3']);
    expect(result).toEqual({ indexed: 3, failed: 0 });
  });

  it('одна упавшая страница не останавливает перестроение', async () => {
    const { service, calls } = buildService([['p-1', 'плохая', 'p-3'], []]);

    const result = await service.indexWorkspace('ws-1');

    expect(calls).toEqual(['p-1', 'плохая', 'p-3']);
    expect(result).toEqual({ indexed: 2, failed: 1 });
  });

  /**
   * Без курсора обход брал бы первую пачку снова и снова: на живой базе это
   * бесконечный цикл, а на подменённом запросе он незаметен.
   */
  it('вторая пачка запрашивается со сдвигом по ключу', async () => {
    const { service, wheres } = buildService([['p-1', 'p-2'], ['p-3'], []]);

    await service.indexWorkspace('ws-1');

    expect(wheres).toContainEqual(['id', '>', 'p-2']);
    expect(wheres).toContainEqual(['id', '>', 'p-3']);
  });

  it('пустое рабочее пространство обходится без вызовов модели', async () => {
    const { service, calls } = buildService([[]]);

    const result = await service.indexWorkspace('ws-1');

    expect(calls).toEqual([]);
    expect(result).toEqual({ indexed: 0, failed: 0 });
  });
});

/**
 * Настройки разрешаются один раз на прогон. Раньше `indexPage` пять раз ходил
 * за ними на каждую страницу, а идентичность читалась внутри цикла, поэтому
 * сохранение настроек в середине оставляло вики разбитой на две идентичности
 * без всякого признака.
 */
describe('EmbeddingService.indexWorkspace, разрешение настроек', () => {
  it('настройки читаются один раз на весь обход', async () => {
    const { service } = buildService([['p-1', 'p-2'], ['p-3'], []]);

    await service.indexWorkspace('ws-1');

    expect(service.embeddingRun).toHaveBeenCalledTimes(1);
  });

  it('один и тот же прогон передается каждой странице', async () => {
    const { service } = buildService([['p-1', 'p-2'], []]);
    const seen: unknown[] = [];
    service.indexPage = jest.fn(async (_id: string, run: unknown) => {
      seen.push(run);
      return { chunks: 1 };
    });

    await service.indexWorkspace('ws-1');

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBeTruthy();
  });
});
