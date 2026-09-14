/**
 * Разбор присутствия.
 *
 * Проверяются правила, ради которых разбор вынесен из компонента: своя вкладка
 * в перечень не попадает, две вкладки одного человека это одна запись, а
 * вкладка, ещё не объявившая себя, не превращается в безымянного участника.
 */

import { describe, expect, it } from 'vitest';

import { presentPeople } from './presence';

function state(clientId: number, user: Record<string, unknown> | undefined) {
  return { clientId, user };
}

describe('presentPeople', () => {
  it('своей вкладки в перечне нет', () => {
    const people = presentPeople([state(1, { id: 'a', name: 'Я' })], 1);
    expect(people).toEqual([]);
  });

  it('чужая вкладка попадает в перечень', () => {
    const people = presentPeople(
      [state(2, { id: 'b', name: 'Пётр', color: 'hsl(10 70% 55%)', avatarUrl: 'p.png' })],
      1
    );
    expect(people).toEqual([
      { id: 'b', name: 'Пётр', color: 'hsl(10 70% 55%)', avatarUrl: 'p.png', tabs: 1 }
    ]);
  });

  it('две вкладки одного человека это одна запись', () => {
    const people = presentPeople(
      [state(2, { id: 'b', name: 'Пётр' }), state(3, { id: 'b', name: 'Пётр' })],
      1
    );
    expect(people).toHaveLength(1);
    expect(people[0].tabs).toBe(2);
  });

  it('своя вторая вкладка это присутствие', () => {
    // Отбрасывается по вкладке, а не по человеку: рядом действительно правят.
    const people = presentPeople(
      [state(1, { id: 'a', name: 'Я' }), state(4, { id: 'a', name: 'Я' })],
      1
    );
    expect(people).toHaveLength(1);
  });

  it('вкладка без имени пропускается', () => {
    // Промежуток между подключением и объявлением себя: запись «?» мигала бы
    // на каждом подключении.
    expect(presentPeople([state(2, undefined), state(3, { id: 'c', name: '  ' })], 1)).toEqual([]);
  });

  it('разные люди без идентификатора не сливаются', () => {
    const people = presentPeople([state(2, { name: 'Анна' }), state(3, { name: 'Пётр' })], 1);
    expect(people.map((one) => one.name)).toEqual(['Анна', 'Пётр']);
  });

  it('порядок по имени, а не по подключению', () => {
    const people = presentPeople(
      [state(2, { id: 'b', name: 'Пётр' }), state(3, { id: 'c', name: 'Анна' })],
      1
    );
    expect(people.map((one) => one.name)).toEqual(['Анна', 'Пётр']);
  });

  it('без своей вкладки перечень полный', () => {
    // Канал ещё не назвал свой номер: скрывать в этот момент некого.
    const people = presentPeople([state(2, { id: 'b', name: 'Пётр' })], null);
    expect(people).toHaveLength(1);
  });
});
