/**
 * Ширина листа на странице по ссылке.
 *
 * У постороннего читателя настроек нет, и переключатель в шапке — единственное
 * место, где он может расширить лист. Проверяется умолчание и то, что выбор
 * переживает закрытие страницы.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { shareWidth } from './width.svelte';

describe('ширина листа по ссылке', () => {
  beforeEach(() => {
    localStorage.clear();
    shareWidth.wide = false;
  });

  it('по умолчанию лист узкий', () => {
    shareWidth.hydrate();
    expect(shareWidth.wide).toBe(false);
  });

  it('выбор помнится', () => {
    shareWidth.toggle();
    expect(shareWidth.wide).toBe(true);
    expect(localStorage.getItem('tessera.share.wide')).toBe('true');

    shareWidth.wide = false;
    shareWidth.hydrate();
    expect(shareWidth.wide).toBe(true);
  });

  it('возврат к узкому тоже помнится', () => {
    shareWidth.toggle();
    shareWidth.toggle();
    expect(shareWidth.wide).toBe(false);

    shareWidth.wide = true;
    shareWidth.hydrate();
    expect(shareWidth.wide).toBe(false);
  });
});
