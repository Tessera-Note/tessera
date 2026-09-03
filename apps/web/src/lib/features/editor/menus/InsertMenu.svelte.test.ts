/**
 * Перечень вставки блоков.
 *
 * Отбор проверяется отдельно (`blocks.test.ts`), здесь — разметка: что блоки
 * разложены по разделам, поиск сужает перечень, а выбор доходит до действия.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InsertMenu from './InsertMenu.svelte';
import { BLOCKS, pagelessBlocks } from '../blocks';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

/** Редактор в объёме, который меню трогает: цепочка вызывается только выбором. */
function fakeEditor() {
  const chain: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(chain, {
    get: () => () => proxy
  });
  return { chain: () => proxy } as never;
}

function render(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(InsertMenu, {
    target: host,
    props: {
      editor: fakeEditor(),
      pageId: 'p1',
      at: { left: 10, top: 20, bottom: 40 },
      fail: () => {},
      onclose: () => {},
      ...props
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function options(box: HTMLElement): string[] {
  return [...box.querySelectorAll('button')].map((one) => (one.textContent ?? '').trim());
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('InsertMenu', () => {
  it('показывает все блоки, разложенные по разделам', () => {
    const box = render();
    expect(options(box)).toHaveLength(BLOCKS.length);
    expect(box.textContent).toContain('Basic blocks');
    expect(box.textContent).toContain('Media');
    expect(box.textContent).toContain('Embeds');
  });

  it('поиск сужает перечень', () => {
    const box = render();
    const field = box.querySelector('input') as HTMLInputElement;

    field.value = 'callout';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    const found = options(box);
    expect(found).toContain('Callout');
    expect(found.length).toBeLessThan(BLOCKS.length);
  });

  it('на бессмысленном запросе говорит, что ничего нет', () => {
    const box = render();
    const field = box.querySelector('input') as HTMLInputElement;

    field.value = 'щщщщ';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    expect(options(box)).toHaveLength(0);
    expect(box.textContent).toContain('No results');
  });

  it('урезанный набор не предлагает того, чему нужна страница', () => {
    // У шаблона страницы нет: загрузка файла и встраивание базы отказали бы.
    const box = render({ blocks: pagelessBlocks() });
    const found = options(box).join(' ');
    expect(found).not.toContain('File attachment');
    expect(found).not.toContain('Kanban');
    expect(found).toContain('Table');
  });

  it('выбор закрывает меню', () => {
    const onclose = vi.fn();
    const box = render({ onclose });

    const table = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Table'
    ) as HTMLElement;
    table.click();
    flushSync();

    expect(onclose).toHaveBeenCalled();
  });

  it('закрывается по Escape из поля поиска', () => {
    const onclose = vi.fn();
    const box = render({ onclose });

    const field = box.querySelector('input') as HTMLInputElement;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();

    expect(onclose).toHaveBeenCalled();
  });
});
