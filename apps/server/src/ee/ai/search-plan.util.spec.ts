import { buildSearchPlan } from './search-plan.util';

/**
 * Замерено на живом случае: на просьбу собрать топ-13 проката ушёл ровно один
 * запрос, вернулось пять ссылок, агент взял из них обрывок и опубликовал
 * страницу с местами с девятого по тринадцатое.
 */
describe('buildSearchPlan', () => {
  const YEAR = 2026;

  it('на один запрос строится несколько заходов', () => {
    const plan = buildSearchPlan(
      'создай страницу с текущими 13 фильмами которые в прокате в топ 13, топ на свое усмотрение с описанием и фото',
      YEAR,
    );

    expect(plan.length).toBeGreaterThan(1);
  });

  // Статей прошлых лет в выдаче по «текущему» всегда много.
  it('один из заходов уточнен годом', () => {
    const plan = buildSearchPlan('фильмы в текущем прокате', YEAR);

    expect(plan.some((q) => q.includes('2026'))).toBe(true);
  });

  // Длинный запрос сужает выдачу, короткий достает списки и обзоры.
  it('есть укороченный заход', () => {
    const plan = buildSearchPlan(
      'текущими 13 фильмами которые в прокате топ описанием фото рейтинг сборы',
      YEAR,
    );
    const shortest = plan
      .map((q) => q.split(' ').length)
      .sort((a, b) => a - b)[0];

    expect(shortest).toBeLessThanOrEqual(5);
  });

  it('просьба перечислить добавляет заход со словом-подсказкой', () => {
    const plan = buildSearchPlan('топ 13 фильмов в прокате', YEAR);

    expect(plan.some((q) => q.includes('рейтинг'))).toBe(true);
  });

  it('обычный вопрос лишних заходов не плодит', () => {
    const plan = buildSearchPlan('погода в Киеве', YEAR);

    expect(plan.length).toBeLessThanOrEqual(2);
  });

  // Один и тот же запрос дважды выдачу не расширяет.
  it('повторов в плане нет', () => {
    const plan = buildSearchPlan('топ фильмов 2026 рейтинг', YEAR);

    expect(new Set(plan).size).toBe(plan.length);
  });

  it('год не дублируется, если он уже в запросе', () => {
    const plan = buildSearchPlan('фильмы 2026 прокат', YEAR);

    expect(plan.every((q) => (q.match(/2026/g) ?? []).length <= 1)).toBe(true);
  });

  it('пустое сообщение дает пустой план', () => {
    expect(buildSearchPlan('', YEAR)).toEqual([]);
  });

  it('первым заходом идет само ядро запроса', () => {
    const plan = buildSearchPlan('какие фильмы сейчас в прокате', YEAR);

    expect(plan[0]).toBe('какие фильмы сейчас прокате');
  });
});
