import { needsWebSearch } from './freshness.util';

describe('needsWebSearch, случай ради которого сделано', () => {
  it('запрос про текущий прокат требует поиска', () => {
    expect(needsWebSearch('Какой сейчас топ проката?')).toBe(true);
    expect(needsWebSearch('составь список фильмов в текущем прокате')).toBe(true);
    expect(needsWebSearch('what is in the box office now')).toBe(true);
  });
});

describe('needsWebSearch, явная просьба', () => {
  it('срабатывает всегда', () => {
    expect(needsWebSearch('поищи про это в интернете')).toBe(true);
    expect(needsWebSearch('search the web for tessera docs')).toBe(true);
  });
});

describe('needsWebSearch, признаки свежести', () => {
  it.each([
    'какие новости по проекту',
    'последние изменения в законе',
    'какая сегодня погода',
    'курс доллара',
    'что вышло в 2026',
    'latest release notes',
    'recent changes',
  ])('«%s» требует поиска', (q) => {
    expect(needsWebSearch(q)).toBe(true);
  });
});

describe('needsWebSearch, обычные вопросы по вики', () => {
  it.each([
    'как оформить отпуск',
    'где лежит инструкция по деплою',
    'опиши архитектуру модуля прав',
    'how do I configure SMTP',
    '',
  ])('«%s» поиска не требует', (q) => {
    expect(needsWebSearch(q)).toBe(false);
  });
});

/**
 * Замерено на живом случае: «изучи разные страницы в инете и реши первичный
 * запрос» поиска не запускало, потому что список готовых фраз такой
 * формулировки не содержал.
 */
describe('needsWebSearch, прямая просьба посмотреть снаружи', () => {
  it.each([
    'изучи разные страницы в инете и реши первичныц запрос',
    'посмотри в интернете кто это',
    'проверь по источникам',
    'глянь в гугле',
    'research this online',
  ])('распознается: %s', (query) => {
    expect(needsWebSearch(query)).toBe(true);
  });

  // Пара обязательна, иначе просьба про вики уводила бы в интернет.
  it.each([
    'найди страницу про отпуска',
    'посмотри что у нас записано',
    'изучи этот раздел',
  ])('не распознается как внешний поиск: %s', (query) => {
    expect(needsWebSearch(query)).toBe(false);
  });
});

/**
 * Признаки свежести есть в первом сообщении, а в уточнениях их нет. Разговор,
 * которому один раз понадобились внешние данные, нуждается в них и дальше.
 */
describe('needsWebSearch, продолжение разговора', () => {
  it('уточнение после поиска тоже ищет', () => {
    expect(
      needsWebSearch('добавь фото и чего нет фильмов с 1 по 8', {
        previousTurnSearched: true,
      }),
    ).toBe(true);
  });

  it('без поиска в прошлом ходе правило прежнее', () => {
    expect(
      needsWebSearch('добавь фото и чего нет фильмов с 1 по 8', {
        previousTurnSearched: false,
      }),
    ).toBe(false);
  });
});
