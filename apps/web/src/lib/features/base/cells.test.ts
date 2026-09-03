import { describe, expect, it } from 'vitest';
import { asList, cellText, choicesOf, isEmptyCell, sortKey } from './cells';

const select = {
  choices: [
    { id: 'c1', name: 'Готово' },
    { id: 'c2', name: 'В работе' },
    { id: 'c3', name: 'Отложено' }
  ],
  choiceOrder: ['c2', 'c1']
};

describe('choicesOf', () => {
  it('ставит варианты в заданном порядке', () => {
    expect(choicesOf(select).map((one) => one.id)).toEqual(['c2', 'c1', 'c3']);
  });

  it('вариант вне порядка не теряется', () => {
    // Порядок и набор правятся раздельно, и рассинхрон между ними обычен.
    expect(choicesOf(select).map((one) => one.id)).toContain('c3');
  });

  it('без порядка отдаёт как есть', () => {
    expect(choicesOf({ choices: select.choices }).map((one) => one.id)).toEqual(['c1', 'c2', 'c3']);
    expect(choicesOf(null)).toEqual([]);
  });
});

describe('isEmptyCell', () => {
  it('считает пустыми пустоту, пустую строку и пустой перечень', () => {
    expect(isEmptyCell(null)).toBe(true);
    expect(isEmptyCell(undefined)).toBe(true);
    expect(isEmptyCell('   ')).toBe(true);
    expect(isEmptyCell([])).toBe(true);
  });

  it('ноль и «ложь» не пусты', () => {
    expect(isEmptyCell(0)).toBe(false);
    expect(isEmptyCell(false)).toBe(false);
  });
});

describe('asList', () => {
  it('приводит одиночное значение к перечню', () => {
    expect(asList('c1')).toEqual(['c1']);
    expect(asList(['c1', 'c2'])).toEqual(['c1', 'c2']);
    expect(asList(null)).toEqual([]);
  });
});

describe('cellText', () => {
  it('показывает название варианта, а не его имя в базе', () => {
    expect(cellText('c1', 'select', select)).toBe('Готово');
    expect(cellText(['c1', 'c2'], 'multiSelect', select)).toBe('Готово, В работе');
  });

  it('показывает имя человека', () => {
    const people = { u1: { id: 'u1', name: 'Пётр', avatarUrl: null } };
    expect(cellText('u1', 'person', null, { people })).toBe('Пётр');
  });

  it('показывает название страницы', () => {
    const pages = { g1: { id: 'g1', slugId: 's', title: 'План', icon: null } };
    expect(cellText('g1', 'page', null, { pages })).toBe('План');
  });

  it('незнакомое значение показывает как есть', () => {
    expect(cellText('нет-такого', 'select', select)).toBe('нет-такого');
    expect(cellText('u9', 'person', null, {})).toBe('u9');
  });

  it('пустая ячейка это пустая строка', () => {
    expect(cellText(null, 'text', null)).toBe('');
    expect(cellText([], 'multiSelect', select)).toBe('');
  });

  it('флажок это true или false', () => {
    expect(cellText(true, 'checkbox', null)).toBe('true');
    expect(cellText(false, 'checkbox', null)).toBe('false');
  });
});

describe('sortKey', () => {
  it('числа сравниваются числами', () => {
    expect(sortKey('10', 'number', null)).toBe(10);
    expect(sortKey('не число', 'number', null)).toBeNull();
  });

  it('даты сравниваются временем', () => {
    expect(sortKey('2026-01-10', 'date', null)).toBe(new Date('2026-01-10').getTime());
    expect(sortKey('не дата', 'date', null)).toBeNull();
  });

  it('остальное сравнивается текстом в нижнем регистре', () => {
    expect(sortKey('Альфа', 'text', null)).toBe('альфа');
  });

  it('пустая ячейка не сравнивается ни с чем', () => {
    expect(sortKey(null, 'number', null)).toBeNull();
    expect(sortKey('', 'text', null)).toBeNull();
  });
});
