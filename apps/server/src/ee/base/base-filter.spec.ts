import {
  matchesBaseRowFilter,
  collectPushdownConditions,
} from './base-filter';

// Среда: 2026-08-05. Неделя понедельник 2026-08-03 — воскресенье 2026-08-09.
const NOW = new Date('2026-08-05T12:00:00.000Z');

function match(
  cells: Record<string, unknown>,
  condition: Record<string, unknown>,
): boolean {
  return matchesBaseRowFilter(cells, condition, NOW);
}

describe('matchesBaseRowFilter, структура', () => {
  it('пропускает строку без фильтра', () => {
    expect(matchesBaseRowFilter({ a: 1 }, undefined, NOW)).toBe(true);
    expect(matchesBaseRowFilter({ a: 1 }, null, NOW)).toBe(true);
    expect(matchesBaseRowFilter({ a: 1 }, {}, NOW)).toBe(true);
  });

  it('пустая группа не фильтрует', () => {
    expect(
      matchesBaseRowFilter({ a: 1 }, { op: 'and', children: [] }, NOW),
    ).toBe(true);
  });

  it('and требует все условия', () => {
    const filter = {
      op: 'and',
      children: [
        { propertyId: 'a', op: 'eq', value: 1 },
        { propertyId: 'b', op: 'eq', value: 2 },
      ],
    };

    expect(matchesBaseRowFilter({ a: 1, b: 2 }, filter, NOW)).toBe(true);
    expect(matchesBaseRowFilter({ a: 1, b: 3 }, filter, NOW)).toBe(false);
  });

  it('or требует хотя бы одно условие', () => {
    const filter = {
      op: 'or',
      children: [
        { propertyId: 'a', op: 'eq', value: 1 },
        { propertyId: 'b', op: 'eq', value: 2 },
      ],
    };

    expect(matchesBaseRowFilter({ a: 9, b: 2 }, filter, NOW)).toBe(true);
    expect(matchesBaseRowFilter({ a: 9, b: 9 }, filter, NOW)).toBe(false);
  });

  it('поддерживает вложенные группы', () => {
    const filter = {
      op: 'and',
      children: [
        { propertyId: 'a', op: 'eq', value: 1 },
        {
          op: 'or',
          children: [
            { propertyId: 'b', op: 'eq', value: 2 },
            { propertyId: 'b', op: 'eq', value: 3 },
          ],
        },
      ],
    };

    expect(matchesBaseRowFilter({ a: 1, b: 3 }, filter, NOW)).toBe(true);
    expect(matchesBaseRowFilter({ a: 1, b: 4 }, filter, NOW)).toBe(false);
  });

  // Регресс: раньше `default: return true` пропускал строку на любом
  // операторе, кроме четырёх известных, то есть фильтр не фильтровал.
  it('неизвестный оператор не пропускает строку', () => {
    expect(
      match({ a: 1 }, { propertyId: 'a', op: 'выдуманный', value: 1 }),
    ).toBe(false);
  });

  it('условие без propertyId игнорируется', () => {
    expect(matchesBaseRowFilter({ a: 1 }, { op: 'eq', value: 5 }, NOW)).toBe(
      true,
    );
  });
});

describe('matchesBaseRowFilter, пустота', () => {
  it.each([null, undefined, '', []])('isEmpty истинно для %p', (value) => {
    expect(match({ a: value }, { propertyId: 'a', op: 'isEmpty' })).toBe(true);
    expect(match({ a: value }, { propertyId: 'a', op: 'isNotEmpty' })).toBe(
      false,
    );
  });

  it.each([0, false, 'x', ['x']])('isNotEmpty истинно для %p', (value) => {
    expect(match({ a: value }, { propertyId: 'a', op: 'isNotEmpty' })).toBe(
      true,
    );
    expect(match({ a: value }, { propertyId: 'a', op: 'isEmpty' })).toBe(false);
  });

  it('отсутствующая ячейка считается пустой', () => {
    expect(match({}, { propertyId: 'нет', op: 'isEmpty' })).toBe(true);
  });
});

describe('matchesBaseRowFilter, равенство', () => {
  it('eq и neq на строках', () => {
    expect(match({ a: 'да' }, { propertyId: 'a', op: 'eq', value: 'да' })).toBe(
      true,
    );
    expect(
      match({ a: 'да' }, { propertyId: 'a', op: 'neq', value: 'да' }),
    ).toBe(false);
    expect(
      match({ a: 'да' }, { propertyId: 'a', op: 'neq', value: 'нет' }),
    ).toBe(true);
  });

  it('число и его строковая запись равны', () => {
    expect(match({ a: 5 }, { propertyId: 'a', op: 'eq', value: '5' })).toBe(
      true,
    );
    expect(match({ a: '5' }, { propertyId: 'a', op: 'eq', value: 5 })).toBe(
      true,
    );
  });

  it('eq на булевом значении', () => {
    expect(match({ a: true }, { propertyId: 'a', op: 'eq', value: true })).toBe(
      true,
    );
    expect(
      match({ a: false }, { propertyId: 'a', op: 'eq', value: true }),
    ).toBe(false);
  });

  it('neq истинно для пустой ячейки', () => {
    expect(match({ a: null }, { propertyId: 'a', op: 'neq', value: 'x' })).toBe(
      true,
    );
  });
});

describe('matchesBaseRowFilter, текст', () => {
  it('contains и ncontains без учета регистра', () => {
    const cells = { a: 'Отчет за Август' };
    expect(
      match(cells, { propertyId: 'a', op: 'contains', value: 'август' }),
    ).toBe(true);
    expect(
      match(cells, { propertyId: 'a', op: 'ncontains', value: 'август' }),
    ).toBe(false);
    expect(
      match(cells, { propertyId: 'a', op: 'contains', value: 'май' }),
    ).toBe(false);
  });

  it('contains ищет по элементам массива', () => {
    expect(
      match(
        { a: ['один', 'два'] },
        { propertyId: 'a', op: 'contains', value: 'два' },
      ),
    ).toBe(true);
  });

  it('пустая подстрока не ограничивает', () => {
    expect(
      match({ a: 'x' }, { propertyId: 'a', op: 'contains', value: '' }),
    ).toBe(true);
  });

  // Регресс: отрицание includesText на незаданной подстроке прятало вообще
  // все строки. Клиент сохраняет условие с пустым значением при смене
  // оператора, так что путь достижим.
  it.each([undefined, null, ''])(
    'ncontains со значением %p не ограничивает',
    (value) => {
      expect(
        match({ a: 'что угодно' }, { propertyId: 'a', op: 'ncontains', value }),
      ).toBe(true);
    },
  );

  it('startsWith и endsWith', () => {
    const cells = { a: 'релиз-2026' };
    expect(
      match(cells, { propertyId: 'a', op: 'startsWith', value: 'релиз' }),
    ).toBe(true);
    expect(
      match(cells, { propertyId: 'a', op: 'endsWith', value: '2026' }),
    ).toBe(true);
    expect(
      match(cells, { propertyId: 'a', op: 'endsWith', value: 'релиз' }),
    ).toBe(false);
  });

  it('contains на пустой ячейке ложно', () => {
    expect(
      match({ a: null }, { propertyId: 'a', op: 'contains', value: 'x' }),
    ).toBe(false);
  });
});

describe('matchesBaseRowFilter, порядок', () => {
  it('числовые сравнения', () => {
    expect(match({ a: 10 }, { propertyId: 'a', op: 'gt', value: 5 })).toBe(
      true,
    );
    expect(match({ a: 10 }, { propertyId: 'a', op: 'gte', value: 10 })).toBe(
      true,
    );
    expect(match({ a: 10 }, { propertyId: 'a', op: 'lt', value: 5 })).toBe(
      false,
    );
    expect(match({ a: 10 }, { propertyId: 'a', op: 'lte', value: 10 })).toBe(
      true,
    );
  });

  it('сравнение чисел не строковое', () => {
    expect(match({ a: 9 }, { propertyId: 'a', op: 'lt', value: 10 })).toBe(
      true,
    );
  });

  it('несравнимые значения не проходят', () => {
    expect(match({ a: null }, { propertyId: 'a', op: 'gt', value: 5 })).toBe(
      false,
    );
  });
});

describe('matchesBaseRowFilter, множества', () => {
  it('any пересечение непустое', () => {
    expect(
      match(
        { a: ['x', 'y'] },
        { propertyId: 'a', op: 'any', value: ['y', 'z'] },
      ),
    ).toBe(true);
    expect(
      match({ a: ['x'] }, { propertyId: 'a', op: 'any', value: ['y', 'z'] }),
    ).toBe(false);
  });

  it('none пересечение пустое', () => {
    expect(
      match({ a: ['x'] }, { propertyId: 'a', op: 'none', value: ['y'] }),
    ).toBe(true);
    expect(
      match({ a: ['x'] }, { propertyId: 'a', op: 'none', value: ['x'] }),
    ).toBe(false);
  });

  it('all требует все значения условия', () => {
    expect(
      match(
        { a: ['x', 'y'] },
        { propertyId: 'a', op: 'all', value: ['x', 'y'] },
      ),
    ).toBe(true);
    expect(
      match({ a: ['x'] }, { propertyId: 'a', op: 'all', value: ['x', 'y'] }),
    ).toBe(false);
  });

  it('скалярная ячейка работает как множество из одного элемента', () => {
    expect(
      match({ a: 'x' }, { propertyId: 'a', op: 'any', value: ['x', 'y'] }),
    ).toBe(true);
  });

  it('пустой список условия не ограничивает', () => {
    expect(match({ a: [] }, { propertyId: 'a', op: 'any', value: [] })).toBe(
      true,
    );
  });
});

describe('matchesBaseRowFilter, даты', () => {
  const exact = (date: string) => ({ mode: 'exact', date });
  const relative = (preset: string) => ({ mode: 'relative', preset });
  const range = (preset: string) => ({ mode: 'range', preset });

  it('before и after по точной дате', () => {
    const cells = { d: '2026-08-05' };
    expect(
      match(cells, {
        propertyId: 'd',
        op: 'before',
        value: exact('2026-08-06'),
      }),
    ).toBe(true);
    expect(
      match(cells, {
        propertyId: 'd',
        op: 'after',
        value: exact('2026-08-04'),
      }),
    ).toBe(true);
    expect(
      match(cells, {
        propertyId: 'd',
        op: 'before',
        value: exact('2026-08-05'),
      }),
    ).toBe(false);
  });

  it('onOrBefore и onOrAfter включают саму дату', () => {
    const cells = { d: '2026-08-05' };
    expect(
      match(cells, {
        propertyId: 'd',
        op: 'onOrBefore',
        value: exact('2026-08-05'),
      }),
    ).toBe(true);
    expect(
      match(cells, {
        propertyId: 'd',
        op: 'onOrAfter',
        value: exact('2026-08-05'),
      }),
    ).toBe(true);
  });

  it('eq по дате сравнивает календарный день, а не момент', () => {
    expect(
      match(
        { d: '2026-08-05T23:41:00.000Z' },
        { propertyId: 'd', op: 'eq', value: exact('2026-08-05') },
      ),
    ).toBe(true);
  });

  it('относительные якоря считаются от переданного now', () => {
    expect(
      match(
        { d: '2026-08-05' },
        { propertyId: 'd', op: 'eq', value: relative('today') },
      ),
    ).toBe(true);
    expect(
      match(
        { d: '2026-08-06' },
        { propertyId: 'd', op: 'eq', value: relative('tomorrow') },
      ),
    ).toBe(true);
    expect(
      match(
        { d: '2026-08-04' },
        { propertyId: 'd', op: 'eq', value: relative('yesterday') },
      ),
    ).toBe(true);
    expect(
      match(
        { d: '2026-07-29' },
        { propertyId: 'd', op: 'eq', value: relative('oneWeekAgo') },
      ),
    ).toBe(true);
    expect(
      match(
        { d: '2026-09-05' },
        { propertyId: 'd', op: 'eq', value: relative('oneMonthFromNow') },
      ),
    ).toBe(true);
  });

  it('isWithin по календарной неделе, начало понедельник', () => {
    expect(
      match(
        { d: '2026-08-03' },
        { propertyId: 'd', op: 'isWithin', value: range('thisWeek') },
      ),
    ).toBe(true);
    expect(
      match(
        { d: '2026-08-09' },
        { propertyId: 'd', op: 'isWithin', value: range('thisWeek') },
      ),
    ).toBe(true);
    expect(
      match(
        { d: '2026-08-10' },
        { propertyId: 'd', op: 'isWithin', value: range('thisWeek') },
      ),
    ).toBe(false);
  });

  it('isWithin по месяцу и году', () => {
    expect(
      match(
        { d: '2026-08-31' },
        { propertyId: 'd', op: 'isWithin', value: range('thisMonth') },
      ),
    ).toBe(true);
    expect(
      match(
        { d: '2026-09-01' },
        { propertyId: 'd', op: 'isWithin', value: range('thisMonth') },
      ),
    ).toBe(false);
    expect(
      match(
        { d: '2026-12-31' },
        { propertyId: 'd', op: 'isWithin', value: range('thisYear') },
      ),
    ).toBe(true);
  });

  it('isWithin по прошедшему и будущему интервалу', () => {
    expect(
      match(
        { d: '2026-08-01' },
        { propertyId: 'd', op: 'isWithin', value: range('pastWeek') },
      ),
    ).toBe(true);
    expect(
      match(
        { d: '2026-07-20' },
        { propertyId: 'd', op: 'isWithin', value: range('pastWeek') },
      ),
    ).toBe(false);
    expect(
      match(
        { d: '2026-08-11' },
        { propertyId: 'd', op: 'isWithin', value: range('nextWeek') },
      ),
    ).toBe(true);
  });

  it('принимает голую строку даты вместо объекта', () => {
    expect(
      match(
        { d: '2026-08-05' },
        { propertyId: 'd', op: 'after', value: '2026-08-01' },
      ),
    ).toBe(true);
  });

  it('нераспознанная дата не проходит', () => {
    expect(
      match(
        { d: 'не дата' },
        { propertyId: 'd', op: 'before', value: exact('2026-08-06') },
      ),
    ).toBe(false);
    expect(
      match(
        { d: '2026-08-05' },
        { propertyId: 'd', op: 'isWithin', value: range('выдуманный') },
      ),
    ).toBe(false);
  });
});

describe('collectPushdownConditions', () => {
  it('собирает дешёвые условия из конъюнкции', () => {
    expect(
      collectPushdownConditions({
        op: 'and',
        children: [
          { propertyId: 'p1', op: 'eq', value: 'да' },
          { propertyId: 'p2', op: 'isEmpty' },
          { propertyId: 'p3', op: 'contains', value: 'текст' },
          { propertyId: 'p4', op: 'isNotEmpty' },
        ],
      }),
    ).toEqual([
      { propertyId: 'p1', op: 'eq', value: 'да' },
      { propertyId: 'p2', op: 'isEmpty' },
      { propertyId: 'p3', op: 'contains', value: 'текст' },
      { propertyId: 'p4', op: 'isNotEmpty' },
    ]);
  });

  // В дизъюнкции сужение по одной ветке отбросило бы строки, проходящие
  // по другой.
  it('ничего не сужает внутри or', () => {
    expect(
      collectPushdownConditions({
        op: 'or',
        children: [
          { propertyId: 'p1', op: 'eq', value: 'да' },
          { propertyId: 'p2', op: 'eq', value: 'нет' },
        ],
      }),
    ).toEqual([]);
  });

  it('не сужает по операторам вне подмножества', () => {
    for (const op of ['any', 'none', 'before', 'isWithin', 'gt', 'ncontains']) {
      expect(
        collectPushdownConditions({ propertyId: 'p1', op, value: 'x' }),
      ).toEqual([]);
    }
  });

  it('не сужает eq по дате и объекту', () => {
    expect(
      collectPushdownConditions({
        propertyId: 'p1',
        op: 'eq',
        value: { mode: 'exact', date: '2026-08-05' },
      }),
    ).toEqual([]);
  });

  it('не сужает contains с пустой подстрокой', () => {
    expect(
      collectPushdownConditions({ propertyId: 'p1', op: 'contains', value: '' }),
    ).toEqual([]);
  });

  it('разворачивает вложенные конъюнкции', () => {
    expect(
      collectPushdownConditions({
        op: 'and',
        children: [
          { propertyId: 'p1', op: 'isEmpty' },
          { op: 'and', children: [{ propertyId: 'p2', op: 'isNotEmpty' }] },
        ],
      }),
    ).toEqual([
      { propertyId: 'p1', op: 'isEmpty' },
      { propertyId: 'p2', op: 'isNotEmpty' },
    ]);
  });

  it('пустой и некорректный фильтр ничего не дают', () => {
    expect(collectPushdownConditions(undefined)).toEqual([]);
    expect(collectPushdownConditions({ op: 'and', children: [] })).toEqual([]);
    expect(collectPushdownConditions({ op: 'eq', value: 'x' })).toEqual([]);
  });
});
