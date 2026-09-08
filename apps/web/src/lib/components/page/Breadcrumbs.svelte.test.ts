/**
 * Цепочка предков над страницей.
 *
 * Проверяется свёртывание. Ветвь ввезённой выгрузки бывает в семь уровней, и
 * каждое название, обрезанное до своей доли ширины, превращалось в
 * «Pr… / M… / AOS:…» — прочесть нельзя ни одно. В v1 показаны первое и
 * последнее, середина убрана под кнопку.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Breadcrumbs from './Breadcrumbs.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function crumbs(count: number) {
  return Array.from({ length: count }, (_one, index) => ({
    id: `p${index}`,
    slugId: `s${index}`,
    title: `Уровень ${index}`
  }));
}

function render(count: number): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(Breadcrumbs, {
    target: host,
    props: { crumbs: crumbs(count), spaceSlug: 'general' }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function names(box: HTMLElement): string[] {
  return [...box.querySelectorAll('nav > a')].map((one) => (one.textContent ?? '').trim());
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('Breadcrumbs', () => {
  it('одна страница цепочки не даёт', () => {
    const box = render(1);
    expect(box.querySelector('nav')).toBeNull();
  });

  it('короткая цепочка показана целиком', () => {
    const box = render(3);
    expect(names(box)).toEqual(['Уровень 0', 'Уровень 1', 'Уровень 2']);
    expect(box.querySelector('[aria-expanded]')).toBeNull();
  });

  it('длинная цепочка сворачивается до первого и последнего', () => {
    const box = render(7);
    expect(names(box)).toEqual(['Уровень 0', 'Уровень 6']);
    expect(box.querySelector('[aria-expanded]')).not.toBeNull();
  });

  it('текущая страница помечена одна', () => {
    // Пометка стояла на каждой крошке, кроме первой: при трёх уровнях
    // промежуточная тоже объявлялась текущей страницей.
    const box = render(3);
    const marked = [...box.querySelectorAll('[aria-current="page"]')].map((one) =>
      (one.textContent ?? '').trim()
    );
    expect(marked).toEqual(['Уровень 2']);
  });

  it('спрятанные уровни открываются кнопкой и остаются ссылками', () => {
    const box = render(7);
    const more = box.querySelector('[aria-expanded]') as HTMLButtonElement;
    more.click();
    flushSync();

    const inside = [...box.querySelectorAll('[role="menuitem"]')].map((one) =>
      (one.textContent ?? '').trim()
    );
    expect(inside).toEqual(['Уровень 1', 'Уровень 2', 'Уровень 3', 'Уровень 4', 'Уровень 5']);
    expect(box.querySelector('[role="menuitem"]')?.getAttribute('href')).toBe('/s/general/p/s1');
  });
});
