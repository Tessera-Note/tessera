import { buildWebSearchQuery } from './search-query.util';

describe('buildWebSearchQuery', () => {
  /**
   * Случай со стенда. В поиск уходил текст целиком, и выдача была про
   * приложения для списков и промокоды онлайн-кинотеатра.
   */
  it('снимает обращение к агенту', () => {
    const query = buildWebSearchQuery(
      'создай страницу с текущими 12 фильмами которіе в прокате в топ 12',
    );

    expect(query).not.toContain('создай');
    expect(query).not.toContain('страницу');
    expect(query).toContain('прокате');
    expect(query).toContain('фильмами');
  });

  it('повтор слова не уточняет запрос и убирается', () => {
    const query = buildWebSearchQuery('топ 12 фильмов в прокате топ 12');

    expect(query.split(' ').filter((w) => w === '12')).toHaveLength(1);
    expect(query.split(' ').filter((w) => w === 'топ')).toHaveLength(1);
  });

  it('обычный вопрос остается почти нетронутым', () => {
    expect(buildWebSearchQuery('какие фильмы сейчас в прокате')).toBe(
      'какие фильмы сейчас прокате',
    );
  });

  it('английская команда снимается так же', () => {
    const query = buildWebSearchQuery(
      'create a page with the current box office top 12',
    );

    expect(query).not.toContain('create');
    expect(query).not.toContain('page');
    expect(query).toContain('box');
    expect(query).toContain('office');
  });

  /**
   * Длинный запрос сужает выдачу до нуля, поэтому число слов ограничено.
   */
  it('длина ограничена', () => {
    const query = buildWebSearchQuery(
      'один два три четыре пять шесть семь восемь девять десять ' +
        'одиннадцать двенадцать тринадцать четырнадцать пятнадцать',
    );

    expect(query.split(' ')).toHaveLength(12);
  });

  /**
   * Сообщение, состоящее почти целиком из обращения к агенту, лучше искать
   * как есть, чем по одному оставшемуся слову.
   */
  it('слишком короткий остаток заменяется исходным сообщением', () => {
    expect(buildWebSearchQuery('создай страницу')).toBe('создай страницу');
  });

  it('пустое сообщение дает пустой запрос', () => {
    expect(buildWebSearchQuery('')).toBe('');
  });

  it('знаки препинания не склеивают слова', () => {
    const query = buildWebSearchQuery('фильмы, прокат: топ-12!');

    expect(query).toContain('фильмы');
    expect(query).toContain('прокат');
    expect(query).toContain('топ-12');
  });
});
