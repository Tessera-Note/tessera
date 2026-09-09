import { describe, expect, it } from 'vitest';
import {
  asList,
  cellText,
  choicesOf,
  dateText,
  isEmptyCell,
  numberText,
  shownChoices,
  sortKey
} from './cells';

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

describe('numberText', () => {
  it('без настроек число показывается как есть', () => {
    expect(numberText(6.66333333333333, null)).toBe('6.66333333333333');
  });

  it('знаки после запятой округляют', () => {
    // Ради этого настройка и заведена: вычисленное среднее показывалось
    // пятнадцатью знаками.
    expect(numberText(6.66333333333333, { precision: 2 })).toBe('6.66');
    expect(numberText(6.669, { precision: 2 })).toBe('6.67');
  });

  it('тысячи разделяются выбранным знаком', () => {
    expect(numberText(1234567.5, { precision: 2 })).toBe('1,234,567.50');
    expect(numberText(1234567.5, { precision: 2, separator: 'space-comma' })).toBe('1 234 567,50');
  });

  it('отрицательное не теряет знак', () => {
    expect(numberText(-1234.5, { precision: 1 })).toBe('-1,234.5');
  });

  it('проценты умножаются на сто', () => {
    expect(numberText(0.42, { format: 'percent', precision: 0 })).toBe('42%');
  });

  it('деньги показываются с кодом валюты', () => {
    expect(numberText(10, { format: 'currency', precision: 2, currency: 'eur' })).toBe('10.00 EUR');
  });
});

describe('dateText', () => {
  it('без настройки время не показывается', () => {
    // У срока время бессмысленно, а показанное «00:00» читается как «в полночь».
    expect(dateText('2026-03-05T14:30:00Z', null, 'en-GB')).toBe('05/03/2026');
  });

  it('со временем показывается и оно', () => {
    const shown = dateText('2026-03-05T14:30:00Z', { includeTime: true }, 'en-GB');
    expect(shown.startsWith('05/03/2026')).toBe(true);
    expect(shown.length).toBeGreaterThan('05/03/2026'.length);
  });

  it('негодная дата показывается как есть', () => {
    expect(dateText('не дата', { includeTime: true })).toBe('не дата');
  });
});

describe('shownChoices', () => {
  const options = {
    choices: [
      { id: 'b', name: 'Бета' },
      { id: 'a', name: 'Альфа' }
    ]
  };

  it('без настройки порядок остаётся тем, в каком варианты завели', () => {
    expect(shownChoices(options).map((one) => one.name)).toEqual(['Бета', 'Альфа']);
  });

  it('с настройкой варианты идут по алфавиту', () => {
    expect(shownChoices({ ...options, alphabetize: true }).map((one) => one.name)).toEqual([
      'Альфа',
      'Бета'
    ]);
  });
});
