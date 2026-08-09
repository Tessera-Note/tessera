import { BaseService } from './base.service';

type RecordedInsert = { table: string; values: Record<string, any> };

/**
 * Значения jsonb-колонок теперь уходят в базу выражением `::text::jsonb`,
 * а не готовой строкой. Разбираем полезную нагрузку из узла выражения.
 */
function jsonbPayload(expression: any): any {
  const node = expression.toOperationNode();
  const value = node.parameters.find((p: any) => p.kind === 'ValueNode');
  return JSON.parse(value.value);
}

function buildService(
  options: {
    existingProperties?: any[];
    pages?: any[];
    accessiblePageIds?: string[];
  } = {},
) {
  const inserts: RecordedInsert[] = [];
  const updates: { table: string; values: Record<string, any> }[] = [];

  const rowsByTable: Record<string, any[]> = {
    baseProperties: options.existingProperties ?? [],
    baseViews: [],
    pages: options.pages ?? [],
  };

  const makeSelectChain = (table: string): any => {
    const chain: any = {
      select: () => chain,
      selectAll: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      executeTakeFirst: async () => undefined,
      execute: async () => rowsByTable[table] ?? [],
    };
    return chain;
  };

  const db: any = {
    selectFrom: (table: string) => makeSelectChain(table),
    insertInto: (table: string) => {
      const chain: any = {
        values: (values: Record<string, any>) => {
          inserts.push({ table, values });
          return chain;
        },
        returningAll: () => chain,
        executeTakeFirstOrThrow: async () => ({ id: 'page-1' }),
        execute: async () => [],
      };
      return chain;
    },
    updateTable: (table: string) => {
      const chain: any = {
        set: (values: Record<string, any>) => {
          updates.push({ table, values });
          return chain;
        },
        where: () => chain,
        returningAll: () => chain,
        executeTakeFirstOrThrow: async () => ({ id: 'row-1', cells: {} }),
        executeTakeFirst: async () => ({ id: 'row-1', cells: {} }),
        execute: async () => [],
      };
      return chain;
    },
    deleteFrom: () => {
      const chain: any = {
        where: () => chain,
        execute: async () => [],
      };
      return chain;
    },
    // executeTx открывает транзакцию через db.transaction(); в тесте она
    // прозрачная, важно лишь что все вставки идут через один и тот же объект.
    transaction: () => ({
      execute: async (callback: (trx: any) => Promise<unknown>) => callback(db),
    }),
  };

  const spaceMemberRepo: any = {
    getUserSpaceIdsQuery: jest.fn().mockReturnValue('подзапрос'),
  };
  const pagePermissionRepo: any = {
    filterAccessiblePageIds: jest
      .fn()
      .mockResolvedValue(
        options.accessiblePageIds ??
          (options.pages ?? []).map((page: any) => page.id),
      ),
  };

  const baseWs: any = { emitToBase: jest.fn() };
  const pageRepo: any = {
    insertPage: jest.fn(async (values: any) => ({ ...values, id: 'page-1' })),
    removePage: jest.fn(),
  };
  const pageService: any = {
    nextPagePosition: jest.fn().mockResolvedValue('a1'),
  };

  const baseRepo: any = {
    findPagesInUserSpaces: jest.fn().mockResolvedValue(options.pages ?? []),
    findBaseIdsInSpace: jest.fn().mockResolvedValue([]),
    bumpSchemaVersion: jest.fn(async () => {
      updates.push({ table: 'pages', values: { baseSchemaVersion: 'bump' } });
    }),
  };

  const service = new BaseService(
    db,
    spaceMemberRepo,
    pagePermissionRepo,
    baseWs,
    pageRepo,
    pageService,
    baseRepo,
  );
  jest
    .spyOn(service, 'getBaseInfo')
    .mockResolvedValue({ id: 'page-1' } as never);

  const viewOf = () => inserts.find((i) => i.table === 'baseViews')?.values;

  return {
    service,
    inserts,
    updates,
    viewOf,
    spaceMemberRepo,
    pagePermissionRepo,
    baseWs,
    pageRepo,
    pageService,
    baseRepo,
  };
}

describe('BaseService.createBase', () => {
  // Регресс: base_views.config объявлена NOT NULL с умолчанием '{}'. Явный
  // null перебивал умолчание, и создание базы без шаблона падало с 500.
  it('пишет пустой config для представления без группировки', async () => {
    const { service, viewOf } = buildService();

    await service.createBase(
      { spaceId: 'space-1' } as any,
      'user-1',
      'workspace-1',
    );

    const view = viewOf();
    expect(view).toBeDefined();
    expect(jsonbPayload(view.config)).toEqual({});
    expect(view.type).toBe('table');
  });

  it('пишет группировку в config для шаблона kanban', async () => {
    const { service, inserts, viewOf } = buildService();

    await service.createBase(
      { spaceId: 'space-1', template: 'kanban' } as any,
      'user-1',
      'workspace-1',
    );

    const view = viewOf();
    const selectProperty = inserts.find(
      (i) => i.table === 'baseProperties' && i.values.type === 'select',
    );

    expect(selectProperty).toBeDefined();
    expect(view.type).toBe('kanban');
    expect(jsonbPayload(view.config)).toEqual({
      groupByPropertyId: selectProperty.values.id,
    });
  });

  // Регресс: сервер писал варианты выбора под ключом options, а клиент читает
  // только choices (base.types.ts, SelectTypeOptions). Доска показывала одну
  // колонку «нет значения», а список статусов был пуст.
  it('описывает варианты статуса в форме, которую читает клиент', async () => {
    const { service, inserts } = buildService();

    await service.createBase(
      { spaceId: 'space-1', template: 'kanban' } as any,
      'user-1',
      'workspace-1',
    );

    const selectProperty = inserts.find(
      (i) => i.table === 'baseProperties' && i.values.type === 'select',
    );
    const typeOptions = jsonbPayload(selectProperty.values.typeOptions);

    expect(Object.keys(typeOptions).sort()).toEqual(['choiceOrder', 'choices']);
    expect(typeOptions.choices).toHaveLength(3);
    expect(typeOptions.choices.map((c: any) => c.category)).toEqual([
      'todo',
      'inProgress',
      'complete',
    ]);
    for (const choice of typeOptions.choices) {
      expect(typeof choice.id).toBe('string');
      expect(typeof choice.name).toBe('string');
      expect(typeof choice.color).toBe('string');
    }
    expect(typeOptions.choiceOrder).toEqual(
      typeOptions.choices.map((c: any) => c.id),
    );
  });

  it('не оставляет config пустым значением ни в одной ветке', async () => {
    for (const dto of [
      { spaceId: 'space-1' },
      { spaceId: 'space-1', template: 'kanban' },
    ]) {
      const { service, viewOf } = buildService();

      await service.createBase(dto as any, 'user-1', 'workspace-1');

      expect(viewOf().config).not.toBeNull();
      expect(viewOf().config).not.toBeUndefined();
      expect(jsonbPayload(viewOf().config)).toEqual(expect.any(Object));
    }
  });
});

describe('BaseService.convertPageToBase', () => {
  it('ставит признак базы', async () => {
    const { service, updates } = buildService();

    await service.convertPageToBase('page-1', undefined, 'user-1', 'ws-1');

    expect(updates).toContainEqual(
      expect.objectContaining({
        table: 'pages',
        values: expect.objectContaining({ isBase: true }),
      }),
    );
  });

  it('создает первичное свойство того же типа, что и база с нуля', async () => {
    const { service, inserts } = buildService();

    await service.convertPageToBase('page-1', undefined, 'user-1', 'ws-1');

    const primary = inserts.find(
      (i) => i.table === 'baseProperties' && i.values.isPrimary,
    );
    expect(primary.values.type).toBe('title');
  });

  // Регресс: канбан создавался без свойства группировки, доска открывалась
  // пустым экраном «нет свойства группировки».
  it('заводит свойство группировки для канбана', async () => {
    const { service, inserts, viewOf } = buildService();

    await service.convertPageToBase('page-1', 'kanban', 'user-1', 'ws-1');

    const statusProperty = inserts.find(
      (i) => i.table === 'baseProperties' && i.values.type === 'select',
    );
    expect(statusProperty).toBeDefined();
    expect(viewOf().type).toBe('kanban');
    expect(jsonbPayload(viewOf().config)).toEqual({
      groupByPropertyId: statusProperty.values.id,
    });
  });

  it('переиспользует существующее свойство выбора для группировки', async () => {
    const { service, inserts, viewOf } = buildService({
      existingProperties: [{ id: 'prop-existing', type: 'status' }],
    });

    await service.convertPageToBase('page-1', 'kanban', 'user-1', 'ws-1');

    expect(inserts.filter((i) => i.table === 'baseProperties')).toHaveLength(0);
    expect(jsonbPayload(viewOf().config)).toEqual({
      groupByPropertyId: 'prop-existing',
    });
  });

  it('для таблицы группировки нет, но config не пустое значение', async () => {
    const { service, viewOf } = buildService();

    await service.convertPageToBase('page-1', undefined, 'user-1', 'ws-1');

    expect(viewOf().type).toBe('table');
    expect(jsonbPayload(viewOf().config)).toEqual({});
  });
});

describe('BaseService.expandPages', () => {
  const page = (id: string) => ({
    id,
    slugId: `slug-${id}`,
    title: `Страница ${id}`,
    icon: null,
    spaceId: 'space-1',
    spaceSlug: 'general',
    spaceName: 'General',
  });

  it('пустой список не ходит в базу', async () => {
    const { service, baseRepo } = buildService();

    await expect(service.expandPages([], 'user-1', 'ws-1')).resolves.toEqual({
      items: [],
    });
    expect(baseRepo.findPagesInUserSpaces).not.toHaveBeenCalled();
  });

  it('отдает метаданные в форме, которую ждет клиент', async () => {
    const { service } = buildService({ pages: [page('p1')] });

    const result = await service.expandPages(['p1'], 'user-1', 'ws-1');

    expect(result.items).toEqual([
      {
        id: 'p1',
        slugId: 'slug-p1',
        title: 'Страница p1',
        icon: null,
        spaceId: 'space-1',
        space: { id: 'space-1', slug: 'general', name: 'General' },
      },
    ]);
  });

  it('ограничивает выдачу пространствами пользователя', async () => {
    const { service, baseRepo } = buildService({ pages: [page('p1')] });

    await service.expandPages(['p1'], 'user-7', 'ws-1');

    expect(baseRepo.findPagesInUserSpaces).toHaveBeenCalledWith(
      ['p1'],
      'user-7',
      'ws-1',
    );
  });

  // Членства в пространстве недостаточно: страница может быть закрыта
  // ограничениями внутри пространства, куда пользователь входит.
  it('убирает страницы, закрытые ограничениями', async () => {
    const { service, pagePermissionRepo } = buildService({
      pages: [page('p1'), page('p2')],
      accessiblePageIds: ['p2'],
    });

    const result = await service.expandPages(['p1', 'p2'], 'user-1', 'ws-1');

    expect(result.items.map((item) => item.id)).toEqual(['p2']);
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['p1', 'p2'],
      userId: 'user-1',
    });
  });

  it('не проверяет ограничения, если пространств не осталось', async () => {
    const { service, pagePermissionRepo } = buildService({ pages: [] });

    const result = await service.expandPages(['p1'], 'user-1', 'ws-1');

    expect(result.items).toEqual([]);
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
  });
});

describe('BaseService, события реального времени', () => {
  it('createRow рассылает созданную строку с идентификатором запроса', async () => {
    const { service, baseWs } = buildService();

    await service.createRow(
      { pageId: 'page-1', cells: { a: 1 }, requestId: 'req-1' } as any,
      'user-1',
      'ws-1',
    );

    expect(baseWs.emitToBase).toHaveBeenCalledWith(
      'page-1',
      expect.objectContaining({
        operation: 'base:row:created',
        requestId: 'req-1',
      }),
    );
  });

  it('updateRow рассылает только измененные ячейки', async () => {
    const { service, baseWs } = buildService();

    await service.updateRow(
      { rowId: 'row-1', pageId: 'page-1', cells: { b: 2 } } as any,
      'user-1',
      'ws-1',
    );

    expect(baseWs.emitToBase).toHaveBeenCalledWith('page-1', {
      operation: 'base:row:updated',
      rowId: 'row-1',
      updatedCells: { b: 2 },
      requestId: null,
    });
  });

  it('deleteRows рассылает список удаленных строк', async () => {
    const { service, baseWs } = buildService();

    await service.deleteRows(['r1', 'r2'], 'page-1', 'ws-1', 'req-9');

    expect(baseWs.emitToBase).toHaveBeenCalledWith('page-1', {
      operation: 'base:rows:deleted',
      rowIds: ['r1', 'r2'],
      requestId: 'req-9',
    });
  });

  it('reorderRow рассылает новую позицию', async () => {
    const { service, baseWs } = buildService();

    await service.reorderRow('row-1', 'page-1', 'h5', 'ws-1');

    expect(baseWs.emitToBase).toHaveBeenCalledWith('page-1', {
      operation: 'base:row:reordered',
      rowId: 'row-1',
      position: 'h5',
      requestId: null,
    });
  });

  it('deleteProperty и deleteView рассылают свои события', async () => {
    const { service, baseWs } = buildService();

    await service.deleteProperty('prop-1', 'page-1', 'ws-1');
    await service.deleteView('view-1', 'page-1', 'ws-1');

    expect(baseWs.emitToBase).toHaveBeenCalledWith('page-1', {
      operation: 'base:property:deleted',
      propertyId: 'prop-1',
    });
    expect(baseWs.emitToBase).toHaveBeenCalledWith('page-1', {
      operation: 'base:view:deleted',
      viewId: 'view-1',
    });
  });
});

describe('BaseService.updateRow, атомарность', () => {
  // Регресс: слияние ячеек делалось в JS между чтением и записью, и двое,
  // меняющие разные ячейки одной строки, затирали правки друг друга.
  it('сливает ячейки запросом к базе, а не в приложении', async () => {
    const { service, updates } = buildService();

    await service.updateRow(
      { rowId: 'row-1', pageId: 'page-1', cells: { b: 2 } } as any,
      'user-1',
      'ws-1',
    );

    const rowUpdate = updates.find((u) => u.table === 'baseRows');
    expect(rowUpdate).toBeDefined();
    // Значение это выражение Kysely, а не готовый JSON: слияние выполняет база.
    expect(typeof rowUpdate.values.cells).toBe('object');
    expect(rowUpdate.values.cells).not.toEqual({ b: 2 });
    expect(typeof rowUpdate.values.cells.compile).toBe('function');
  });

  it('не читает строку отдельным запросом перед записью', async () => {
    const { service } = buildService();
    const readSpy = jest.spyOn(service, 'getRowInfo');

    await service.updateRow(
      { rowId: 'row-1', pageId: 'page-1', cells: { b: 2 } } as any,
      'user-1',
      'ws-1',
    );

    expect(readSpy).not.toHaveBeenCalled();
  });
});

describe('BaseService, страницы через PageRepo', () => {
  it('createBase вставляет страницу через PageRepo, а не напрямую', async () => {
    const { service, pageRepo, inserts } = buildService();

    await service.createBase({ spaceId: 'space-1' } as any, 'user-1', 'ws-1');

    expect(pageRepo.insertPage).toHaveBeenCalledTimes(1);
    expect(inserts.some((i) => i.table === 'pages')).toBe(false);
  });

  it('createBase берет slugId и position общим способом', async () => {
    const { service, pageRepo, pageService } = buildService();

    await service.createBase({ spaceId: 'space-1' } as any, 'user-1', 'ws-1');

    const values = pageRepo.insertPage.mock.calls[0][0];
    // generateSlugId дает десять символов, обрезанный UUID давал восемь
    expect(values.slugId).toHaveLength(10);
    expect(values.position).toBe('a1');
    expect(pageService.nextPagePosition).toHaveBeenCalledWith(
      'space-1',
      undefined,
    );
  });

  it('createBase передает вставку в ту же транзакцию', async () => {
    const { service, pageRepo } = buildService();

    await service.createBase({ spaceId: 'space-1' } as any, 'user-1', 'ws-1');

    expect(pageRepo.insertPage.mock.calls[0][1]).toBeDefined();
  });

  // Прямой update не слал PAGE_SOFT_DELETED, из-за чего эмбеддинги удаленной
  // базы оставались в базе, а потомки не помечались.
  it('deleteBase удаляет через PageRepo', async () => {
    const { service, pageRepo, updates } = buildService();

    await service.deleteBase('page-1', 'user-1', 'ws-1');

    expect(pageRepo.removePage).toHaveBeenCalledWith(
      'page-1',
      'user-1',
      'ws-1',
    );
    expect(updates.some((u) => u.table === 'pages')).toBe(false);
  });
});

describe('BaseService, форма jsonb во всех точках записи', () => {
  it('createRow пишет ячейки выражением, а не строкой', async () => {
    const { service, inserts } = buildService();

    await service.createRow(
      { pageId: 'page-1', cells: { a: 1 } } as any,
      'user-1',
      'ws-1',
    );

    const row = inserts.find((i) => i.table === 'baseRows');
    expect(jsonbPayload(row.values.cells)).toEqual({ a: 1 });
  });

  it('createRow без ячеек пишет пустой объект, а не null', async () => {
    const { service, inserts } = buildService();

    await service.createRow({ pageId: 'page-1' } as any, 'user-1', 'ws-1');

    const row = inserts.find((i) => i.table === 'baseRows');
    expect(jsonbPayload(row.values.cells)).toEqual({});
  });

  it('createProperty пишет typeOptions выражением', async () => {
    const { service, inserts } = buildService();

    await service.createProperty(
      {
        pageId: 'page-1',
        name: 'Поле',
        type: 'select',
        typeOptions: { choices: [] },
      } as any,
      'ws-1',
    );

    const property = inserts.find((i) => i.table === 'baseProperties');
    expect(jsonbPayload(property.values.typeOptions)).toEqual({ choices: [] });
  });

  // Ограничение допускает SQL NULL, и свойство без настроек должно получать
  // именно его, а не пустой объект.
  it('createProperty без typeOptions пишет SQL NULL', async () => {
    const { service, inserts } = buildService();

    await service.createProperty(
      { pageId: 'page-1', name: 'Поле', type: 'text' } as any,
      'ws-1',
    );

    const property = inserts.find((i) => i.table === 'baseProperties');
    expect(property.values.typeOptions).toBeNull();
  });

  it('updateProperty пишет typeOptions выражением', async () => {
    const { service, updates } = buildService();

    await service.updateProperty(
      {
        pageId: 'page-1',
        propertyId: 'p1',
        typeOptions: { choices: [1] },
      } as any,
      'ws-1',
    );

    const update = updates.find((u) => u.table === 'baseProperties');
    expect(jsonbPayload(update.values.typeOptions)).toEqual({ choices: [1] });
  });

  // Регресс: через toJsonb с `?? {}` сброс свойства в NULL был недостижим.
  it('updateProperty с явным null сбрасывает в SQL NULL', async () => {
    const { service, updates } = buildService();

    await service.updateProperty(
      { pageId: 'page-1', propertyId: 'p1', typeOptions: null } as any,
      'ws-1',
    );

    const update = updates.find((u) => u.table === 'baseProperties');
    expect(update.values.typeOptions).toBeNull();
  });

  it('updateProperty без typeOptions поле не трогает', async () => {
    const { service, updates } = buildService();

    await service.updateProperty(
      { pageId: 'page-1', propertyId: 'p1', name: 'Новое' } as any,
      'ws-1',
    );

    const update = updates.find((u) => u.table === 'baseProperties');
    expect('typeOptions' in update.values).toBe(false);
  });

  it('createView пишет config выражением', async () => {
    const { service, inserts } = buildService();

    await service.createView(
      { pageId: 'page-1', name: 'Вид', config: { sorts: [] } } as any,
      'user-1',
      'ws-1',
    );

    const view = inserts.find((i) => i.table === 'baseViews');
    expect(jsonbPayload(view.values.config)).toEqual({ sorts: [] });
  });

  it('createView без config пишет пустой объект', async () => {
    const { service, inserts } = buildService();

    await service.createView(
      { pageId: 'page-1', name: 'Вид' } as any,
      'user-1',
      'ws-1',
    );

    const view = inserts.find((i) => i.table === 'baseViews');
    expect(jsonbPayload(view.values.config)).toEqual({});
  });

  it('updateView пишет config выражением', async () => {
    const { service, updates } = buildService();

    await service.updateView(
      {
        pageId: 'page-1',
        viewId: 'v1',
        config: { groupByPropertyId: 'p1' },
      } as any,
      'ws-1',
    );

    const update = updates.find((u) => u.table === 'baseViews');
    expect(jsonbPayload(update.values.config)).toEqual({
      groupByPropertyId: 'p1',
    });
  });

  it('все пять методов поднимают версию схемы, кроме createRow', async () => {
    for (const run of [
      (s: any) =>
        s.createProperty({ pageId: 'page-1', name: 'П', type: 'text' }, 'ws-1'),
      (s: any) =>
        s.updateProperty(
          { pageId: 'page-1', propertyId: 'p1', name: 'П' },
          'ws-1',
        ),
      (s: any) =>
        s.createView({ pageId: 'page-1', name: 'В' }, 'user-1', 'ws-1'),
      (s: any) =>
        s.updateView({ pageId: 'page-1', viewId: 'v1', name: 'В' }, 'ws-1'),
    ]) {
      const { service, updates } = buildService();
      await run(service);
      expect(
        updates.some(
          (u) => u.table === 'pages' && 'baseSchemaVersion' in u.values,
        ),
      ).toBe(true);
    }

    const { service, updates } = buildService();
    await service.createRow({ pageId: 'page-1' } as any, 'user-1', 'ws-1');
    expect(updates.some((u) => u.table === 'pages')).toBe(false);
  });
});
