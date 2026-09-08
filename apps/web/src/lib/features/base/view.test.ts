import { describe, expect, it } from 'vitest';
import {
  type Column,
  type Row,
  chooseView,
  matches,
  sortRows,
  viewRows,
  visibleColumns
} from './view';
import type { FilterGroup, ViewConfig } from './types';

const columns: Column[] = [
  { id: 'p1', name: 'Название', type: 'title', position: 'a', typeOptions: null, isPrimary: true },
  { id: 'p2', name: 'Число', type: 'number', position: 'b', typeOptions: null, isPrimary: false },
  {
    id: 'p3',
    name: 'Состояние',
    type: 'select',
    position: 'c',
    typeOptions: {
      choices: [
        { id: 'c1', name: 'Готово' },
        { id: 'c2', name: 'В работе' }
      ],
      choiceOrder: ['c2', 'c1']
    },
    isPrimary: false
  },
  { id: 'p4', name: 'Срок', type: 'date', position: 'd', typeOptions: null, isPrimary: false }
];

const rows: Row[] = [
  { id: 'r1', position: 'a', cells: { p1: 'Альфа', p2: 10, p3: 'c1', p4: '2026-01-10' } },
  { id: 'r2', position: 'b', cells: { p1: 'Бета', p2: 2, p3: 'c2', p4: '2026-03-05' } },
  { id: 'r3', position: 'c', cells: { p1: 'Гамма', p2: null, p3: null, p4: null } }
];

const group = (...children: FilterGroup['children']): FilterGroup => ({ op: 'and', children });

describe('visibleColumns', () => {
  it('без настроек отдаёт всё в исходном порядке', () => {
    expect(visibleColumns(columns, {}).map((one) => one.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('прячет перечисленные', () => {
    const config: ViewConfig = { hiddenPropertyIds: ['p2', 'p4'] };
    expect(visibleColumns(columns, config).map((one) => one.id)).toEqual(['p1', 'p3']);
  });

  it('первичное свойство не прячется', () => {
    const config: ViewConfig = { hiddenPropertyIds: ['p1'] };
    expect(visibleColumns(columns, config).map((one) => one.id)).toContain('p1');
  });

  it('ставит колонки в заданном порядке, а незнакомые в конец', () => {
    const config: ViewConfig = { propertyOrder: ['p3', 'p1'] };
    expect(visibleColumns(columns, config).map((one) => one.id)).toEqual(['p3', 'p1', 'p2', 'p4']);
  });
});

describe('matches', () => {
  it('пустой отбор подходит всему', () => {
    expect(matches(rows[0], undefined, columns)).toBe(true);
    expect(matches(rows[0], group(), columns)).toBe(true);
  });

  it('ищет по тексту', () => {
    const filter = group({ propertyId: 'p1', op: 'contains', value: 'льф' });
    expect(rows.filter((row) => matches(row, filter, columns)).map((one) => one.id)).toEqual([
      'r1'
    ]);
  });

  it('сравнивает числа числами, а не строками', () => {
    // Строковое сравнение поставило бы «10» ниже «2».
    const filter = group({ propertyId: 'p2', op: 'gt', value: 5 });
    expect(rows.filter((row) => matches(row, filter, columns)).map((one) => one.id)).toEqual([
      'r1'
    ]);
  });

  it('сравнивает даты временем', () => {
    const filter = group({ propertyId: 'p4', op: 'before', value: '2026-02-01' });
    expect(rows.filter((row) => matches(row, filter, columns)).map((one) => one.id)).toEqual([
      'r1'
    ]);
  });

  it('ищет по названию варианта, а не по его имени в базе', () => {
    const filter = group({ propertyId: 'p3', op: 'eq', value: 'готово' });
    expect(rows.filter((row) => matches(row, filter, columns)).map((one) => one.id)).toEqual([
      'r1'
    ]);
  });

  it('различает заполненное и пустое', () => {
    const empty = group({ propertyId: 'p2', op: 'isEmpty' });
    expect(rows.filter((row) => matches(row, empty, columns)).map((one) => one.id)).toEqual(['r3']);

    const filled = group({ propertyId: 'p2', op: 'isNotEmpty' });
    expect(rows.filter((row) => matches(row, filled, columns)).map((one) => one.id)).toEqual([
      'r1',
      'r2'
    ]);
  });

  it('пустая ячейка не попадает в «не равно»', () => {
    // Иначе незаполненная строка проходила бы в любой отбор.
    const filter = group({ propertyId: 'p3', op: 'neq', value: 'готово' });
    expect(rows.filter((row) => matches(row, filter, columns)).map((one) => one.id)).toEqual([
      'r2'
    ]);
  });

  it('соединяет условия и через «и», и через «или»', () => {
    const both: FilterGroup = {
      op: 'and',
      children: [
        { propertyId: 'p2', op: 'gte', value: 2 },
        { propertyId: 'p1', op: 'contains', value: 'б' }
      ]
    };
    expect(rows.filter((row) => matches(row, both, columns)).map((one) => one.id)).toEqual(['r2']);

    const either: FilterGroup = {
      op: 'or',
      children: [
        { propertyId: 'p1', op: 'eq', value: 'альфа' },
        { propertyId: 'p1', op: 'eq', value: 'гамма' }
      ]
    };
    expect(rows.filter((row) => matches(row, either, columns)).map((one) => one.id)).toEqual([
      'r1',
      'r3'
    ]);
  });

  it('условие о неизвестном свойстве не отсеивает ничего', () => {
    // Свойство могли удалить, а отбор остался: терять из-за этого все строки
    // хуже, чем показать лишние.
    const filter = group({ propertyId: 'нет-такого', op: 'eq', value: 'x' });
    expect(rows.filter((row) => matches(row, filter, columns))).toHaveLength(3);
  });
});

describe('sortRows', () => {
  it('без сортировок оставляет порядок позиций', () => {
    expect(sortRows(rows, {}, columns).map((one) => one.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('сортирует числа по величине', () => {
    const config: ViewConfig = { sorts: [{ propertyId: 'p2', direction: 'asc' }] };
    expect(sortRows(rows, config, columns).map((one) => one.id)).toEqual(['r2', 'r1', 'r3']);
  });

  it('пустые остаются внизу при любом направлении', () => {
    const down: ViewConfig = { sorts: [{ propertyId: 'p2', direction: 'desc' }] };
    expect(sortRows(rows, down, columns).map((one) => one.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('вторая сортировка решает при равенстве первой', () => {
    const same: Row[] = [
      { id: 'x', position: 'a', cells: { p2: 1, p1: 'Б' } },
      { id: 'y', position: 'b', cells: { p2: 1, p1: 'А' } }
    ];
    const config: ViewConfig = {
      sorts: [
        { propertyId: 'p2', direction: 'asc' },
        { propertyId: 'p1', direction: 'asc' }
      ]
    };
    expect(sortRows(same, config, columns).map((one) => one.id)).toEqual(['y', 'x']);
  });
});

describe('viewRows', () => {
  it('отбирает и упорядочивает разом', () => {
    const config: ViewConfig = {
      filter: group({ propertyId: 'p2', op: 'isNotEmpty' }),
      sorts: [{ propertyId: 'p2', direction: 'desc' }]
    };
    expect(viewRows(rows, config, columns).map((one) => one.id)).toEqual(['r1', 'r2']);
  });
});

describe('chooseView', () => {
  const views = [{ id: 'grid' }, { id: 'board' }];

  it('оставляет выбранное представление при перечитывании', () => {
    expect(chooseView(views, 'board')).toBe('board');
  });

  it('берёт первое, когда ничего не выбрано', () => {
    expect(chooseView(views, null)).toBe('grid');
  });

  it('берёт первое, когда выбранное удалили', () => {
    expect(chooseView(views, 'calendar')).toBe('grid');
  });

  it('отдаёт пустоту, когда представлений нет', () => {
    expect(chooseView([], 'grid')).toBeNull();
  });
});
