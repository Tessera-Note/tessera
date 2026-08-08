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
