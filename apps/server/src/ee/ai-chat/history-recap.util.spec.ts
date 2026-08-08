import { buildHistoryRecap } from './history-recap.util';

/**
 * Живой сценарий: агент создал страницу, а на просьбу «расширь страницу»
 * ответил, что её адрес ему не передан, и попросил прислать ссылку на
 * только что созданную им же страницу.
 */
describe('buildHistoryRecap', () => {
  it('созданная страница попадает в пересказ с идентификатором', () => {
    const recap = buildHistoryRecap([
      {
        name: 'create_page',
        args: { pageId: 'p-1', title: 'Топ-12 фильмов в текущем прокате' },
        result: { status: 'applied' },
      },
    ]);

    expect(recap).toContain('p-1');
    expect(recap).toContain('Топ-12 фильмов в текущем прокате');
  });

  // Ссылаться не на что: страница не создана.
  it('отказавшая правка в пересказ не попадает', () => {
    const recap = buildHistoryRecap([
      {
        name: 'create_page',
        args: { pageId: 'p-1', title: 'Черновик' },
        result: { status: 'refused', reason: 'нет прав' },
      },
    ]);

    expect(recap).toBe('');
  });

  it('измененная страница отличается от созданной', () => {
    const recap = buildHistoryRecap([
      {
        name: 'update_page',
        args: { pageId: 'p-2' },
        result: { status: 'applied' },
      },
    ]);

    expect(recap).toContain('edited pages');
    expect(recap).not.toContain('created pages');
  });

  it('найденное в вики переносится с идентификаторами', () => {
    const recap = buildHistoryRecap([
      {
        name: 'search_pages',
        args: { query: 'фильмы' },
        result: {
          method: 'semantic',
          pages: [
            { id: 'p-3', title: 'фильмы' },
            { id: 'p-4', title: 'Топ-10' },
          ],
        },
      },
    ]);

    expect(recap).toContain('p-3');
    expect(recap).toContain('p-4');
  });

  it('найденное в интернете переносится со ссылками', () => {
    const recap = buildHistoryRecap([
      {
        name: 'search_web',
        args: { query: 'прокат' },
        result: {
          count: 1,
          results: [
            { title: 'Список лидеров проката', url: 'https://example.org/a' },
          ],
        },
      },
    ]);

    expect(recap).toContain('https://example.org/a');
    expect(recap).toContain('Список лидеров проката');
  });

  it('пустые и негодные входные данные дают пустой пересказ', () => {
    expect(buildHistoryRecap(undefined)).toBe('');
    expect(buildHistoryRecap([])).toBe('');
    expect(buildHistoryRecap('строка')).toBe('');
    expect(buildHistoryRecap([null, 42])).toBe('');
  });

  // Длинный чат иначе вытеснил бы из окна собственно разговор.
  it('число позиций ограничено', () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({
      id: `p-${i}`,
      title: `Страница ${i}`,
    }));

    const recap = buildHistoryRecap([
      { name: 'search_pages', args: {}, result: { pages } },
    ]);

    expect(recap.match(/p-\d+/g)).toHaveLength(8);
  });

  it('длинный заголовок обрезается', () => {
    const recap = buildHistoryRecap([
      {
        name: 'create_page',
        args: { pageId: 'p-1', title: 'я'.repeat(400) },
        result: { status: 'applied' },
      },
    ]);

    expect(recap).toContain('…');
    expect(recap.length).toBeLessThan(400);
  });

  it('несколько видов действий собираются в один пересказ', () => {
    const recap = buildHistoryRecap([
      {
        name: 'search_web',
        result: { results: [{ title: 'A', url: 'https://a.test' }] },
      },
      {
        name: 'create_page',
        args: { pageId: 'p-9', title: 'Итог' },
        result: { status: 'applied' },
      },
    ]);

    expect(recap).toContain('created pages');
    expect(recap).toContain('web results');
  });
});
