/**
 * Порядок пространств в панели.
 *
 * Проверяется устойчивость: отмеченные наверх, остальное — как пришло. Своя
 * сортировка внутри групп означала бы, что список переставляется по правилу,
 * которого человек не задавал.
 */

import { describe, expect, it } from 'vitest';
import { favoritesFirst } from './ordering';

const spaces = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

function order(favorites: string[]): string[] {
  return favoritesFirst(spaces, new Set(favorites)).map((one) => one.id);
}

describe('favoritesFirst', () => {
  it('поднимает отмеченные наверх', () => {
    expect(order(['c'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('сохраняет порядок сервера внутри групп', () => {
    expect(order(['d', 'b'])).toEqual(['b', 'd', 'a', 'c']);
  });

  it('без отметок ничего не меняет', () => {
    expect(order([])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('не трогает исходный перечень', () => {
    const source = [{ id: 'x' }, { id: 'y' }];
    favoritesFirst(source, new Set(['y']));
    expect(source.map((one) => one.id)).toEqual(['x', 'y']);
  });
});
