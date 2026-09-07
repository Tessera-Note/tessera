/**
 * Упоминание страницы в реплике разговора.
 *
 * Поле разговора — обычная строка, а не редактор, поэтому подсказчик работает
 * по тексту. Проверяется то, на чём такой подсказчик обычно и спотыкается:
 * адрес почты, каретка посреди строки и упоминание, стёртое человеком уже
 * после выбора.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchPages = vi.fn();
vi.mock('$lib/features/search/services/search', () => ({
  searchPages: (...args: unknown[]) => searchPages(...args)
}));

const { LIMIT, insert, present, queryAt, suggestions } = await import('./mentions');

beforeEach(() => {
  searchPages.mockReset();
});

describe('queryAt', () => {
  it('берёт набранное после собаки', () => {
    expect(queryAt('смотри @регл', 12)).toBe('регл');
  });

  it('пустое после собаки — это тоже подсказка', () => {
    // Список нужен сразу: человек нажал `@` и ждёт, что ему предложат.
    expect(queryAt('смотри @', 8)).toBe('');
  });

  it('адрес почты упоминанием не считается', () => {
    // Перед собакой слово вплотную: это почта, и лезть в неё подсказками
    // значит мешать набирать адрес.
    expect(queryAt('пиши на кто@example', 19)).toBeNull();
  });

  it('пробел после собаки закрывает подсказку', () => {
    expect(queryAt('смотри @ регл', 13)).toBeNull();
  });

  it('без собаки подсказывать нечего', () => {
    expect(queryAt('обычная строка', 14)).toBeNull();
  });

  it('считается от каретки, а не от конца строки', () => {
    // Человек вернулся мышью в середину набранного: подсказка относится к
    // тому месту, где стоит каретка.
    expect(queryAt('смотри @рег и дальше', 11)).toBe('рег');
  });
});

describe('insert', () => {
  it('меняет набранное на название и ставит каретку после него', () => {
    const made = insert('смотри @регл', 12, 'Регламент');
    expect(made.text).toBe('смотри @Регламент ');
    expect(made.caret).toBe(made.text.length);
  });

  it('сохраняет хвост строки', () => {
    const made = insert('смотри @рег и дальше', 11, 'Регламент');
    expect(made.text).toBe('смотри @Регламент  и дальше');
    // Каретка встаёт сразу после вставленного, а не в конце строки.
    expect(made.text.slice(0, made.caret)).toBe('смотри @Регламент ');
  });

  it('без собаки строка не меняется', () => {
    const made = insert('обычная строка', 5, 'Регламент');
    expect(made.text).toBe('обычная строка');
  });
});

describe('present', () => {
  const chosen = [
    { id: 'p1', title: 'Регламент' },
    { id: 'p2', title: 'Отчёт' }
  ];

  it('оставляет те упоминания, что стоят в тексте', () => {
    expect(present('смотри @Регламент', chosen)).toEqual([chosen[0]]);
  });

  it('стёртое упоминание на сервер не уходит', () => {
    // Иначе модель получает страницу, о которой её не спрашивали.
    expect(present('смотри просто так', chosen)).toEqual([]);
  });

  it('повтор одной страницы уходит один раз', () => {
    const twice = [...chosen, { id: 'p1', title: 'Регламент' }];
    expect(present('@Регламент и ещё @Регламент', twice)).toEqual([chosen[0]]);
  });
});

describe('suggestions', () => {
  it('отдаёт не больше, чем помещается над полем', async () => {
    searchPages.mockResolvedValue(
      Array.from({ length: 20 }, (_, at) => ({ id: `p${at}`, title: `Страница ${at}` }))
    );

    const found = await suggestions('стр');

    expect(found).toHaveLength(LIMIT);
    expect(searchPages).toHaveBeenCalledWith('стр');
  });
});
