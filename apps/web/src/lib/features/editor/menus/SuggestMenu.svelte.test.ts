/**
 * Перечень подбора по знаку.
 *
 * Разбор запроса проверяется отдельно (`suggest.test.ts`), здесь — разметка:
 * что строки нарисованы, выбранная помечена для чтения с экрана, а нажатие и
 * наведение доходят до вызывающего.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SuggestMenu from './SuggestMenu.svelte';
import type { SuggestItem } from '../suggest';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

const items: SuggestItem[] = [
  { key: 'a', label: 'Таблица' },
  { key: 'b', label: 'Врезка', hint: 'подсказка' },
  { key: 'c', label: 'smile', glyph: '😄' }
];

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(SuggestMenu, {
    target: host,
    props: {
      items,
      index: 0,
      at: { left: 10, top: 20, bottom: 40 },
      empty: 'Ничего не найдено',
      onpick: () => {},
      onhover: () => {},
      ...props
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('SuggestMenu', () => {
  it('рисует все строки', () => {
    const box = render({});
    const options = box.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toContain('Таблица');
    expect(options[1].textContent).toContain('подсказка');
    expect(options[2].textContent).toContain('😄');
  });

  it('помечает выбранную строку для чтения с экрана', () => {
    // Без `aria-selected` человек, читающий экран, не знает, что выберет Enter.
    const box = render({ index: 1 });
    const selected = [...box.querySelectorAll('[role="option"]')].filter(
      (one) => one.getAttribute('aria-selected') === 'true'
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('Врезка');
  });

  it('сообщает о нажатии строкой и её местом', () => {
    const onpick = vi.fn();
    const box = render({ onpick });

    (box.querySelectorAll('[role="option"]')[2] as HTMLElement).click();
    flushSync();

    expect(onpick).toHaveBeenCalledWith(items[2], 2);
  });

  it('сообщает о наведении', () => {
    const onhover = vi.fn();
    const box = render({ onhover });

    const option = box.querySelectorAll('[role="option"]')[1] as HTMLElement;
    option.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    flushSync();

    expect(onhover).toHaveBeenCalledWith(1);
  });

  it('на пустом перечне показывает объяснение, а не пустую рамку', () => {
    const box = render({ items: [] });
    expect(box.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(box.textContent).toContain('Ничего не найдено');
  });

  it('пока идёт запрос, вместо объяснения стоит многоточие', () => {
    // Иначе за время запроса человек читает «ничего не найдено» — при том, что
    // искать ещё не закончили.
    const box = render({ items: [], loading: true });
    expect(box.textContent).toContain('…');
    expect(box.textContent).not.toContain('Ничего не найдено');
  });

  it('становится под знаком-запятнателем', () => {
    const box = render({ at: { left: 120, top: 200, bottom: 220 } });
    const menu = box.querySelector('[data-component="SuggestMenu"]') as HTMLElement;
    expect(menu.style.left).toBe('120px');
    expect(menu.style.top).toBe('224px');
  });
});
