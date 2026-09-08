/**
 * Открытое пространство.
 *
 * Правило решает, у какого пространства в панели раскрыто дерево. Ошибка в нём
 * не видна типами: дерево просто пропадает.
 */

import { describe, expect, it } from 'vitest';
import { openSpaceSlug } from './open';

describe('openSpaceSlug', () => {
  it('берёт пространство из адреса', () => {
    expect(openSpaceSlug({ spaceSlug: 'general' }, null)).toBe('general');
  });

  it('у базы берёт его из данных экрана', () => {
    expect(openSpaceSlug({}, { space: { slug: 'general' } })).toBe('general');
  });

  it('адрес важнее данных: они могли остаться от прошлого экрана', () => {
    expect(openSpaceSlug({ spaceSlug: 'other' }, { space: { slug: 'general' } })).toBe('other');
  });

  it('без того и другого не раскрывает ничего', () => {
    expect(openSpaceSlug({}, null)).toBeNull();
    expect(openSpaceSlug({}, { space: null })).toBeNull();
  });
});
