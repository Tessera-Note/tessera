/**
 * Метка состояния.
 *
 * Свои правки метка пишет не в себя, а в узел документа, поэтому проверяются
 * вызовы записи, а не показанное значение: показанное придёт обратно из
 * документа, и подменять его здесь значило бы проверять подмену.
 */

import { Schema } from '@tiptap/pm/model';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import StatusView from './StatusView.svelte';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    status: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { text: { default: '' }, color: { default: 'gray' } }
    },
    text: { group: 'inline' }
  }
});

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

type World = {
  written: Record<string, unknown>[];
  deleted: { from: number; to: number }[];
  autoOpen: boolean;
};

function render(
  attributes: Record<string, unknown> = { text: '', color: 'gray' },
  options: { editable?: boolean; autoOpen?: boolean } = {}
): World {
  const world: World = { written: [], deleted: [], autoOpen: options.autoOpen ?? false };
  const chain = () => {
    const link = {
      focus: () => link,
      deleteRange: (range: { from: number; to: number }) => {
        world.deleted.push(range);
        return link;
      },
      run: () => true
    };
    return link;
  };

  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(StatusView, {
    target: host,
    props: {
      node: schema.node('status', attributes),
      attributes,
      selected: false,
      editable: options.editable ?? true,
      editor: {
        get storage() {
          return {
            status: {
              get autoOpen() {
                return world.autoOpen;
              },
              set autoOpen(value) {
                world.autoOpen = value;
              }
            }
          };
        },
        commands: { focus: () => true },
        chain
      } as never,
      updateAttributes: (values: Record<string, unknown>) => world.written.push(values),
      position: () => 5
    }
  }) as Record<string, unknown>;
  flushSync();
  return world;
}

function badge(): HTMLElement {
  const found = host?.querySelector<HTMLElement>('[data-component="StatusView"]');
  if (!found) throw new Error('метки нет');
  return found;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('StatusView', () => {
  it('зовёт заполнить, пока текста нет', () => {
    render();
    expect(badge().textContent?.trim()).toBe('Set status');
  });

  it('показывает записанный текст', () => {
    render({ text: 'ГОТОВО', color: 'green' });
    expect(badge().textContent?.trim()).toBe('ГОТОВО');
    expect(badge().className).toContain('emerald');
  });

  it('в чтении не открывает правку', () => {
    render({ text: 'ГОТОВО', color: 'green' }, { editable: false });
    badge().click();
    flushSync();
    expect(host?.querySelector('[role="dialog"]')).toBeNull();
  });

  it('в чтении пустую метку не показывает', () => {
    render({ text: '', color: 'gray' }, { editable: false });
    expect(host?.querySelector('[data-component="StatusView"]')).toBeNull();
  });

  it('пишет набранный текст заглавными', () => {
    const world = render();
    badge().click();
    flushSync();
    const field = host?.querySelector<HTMLInputElement>('input');
    if (!field) throw new Error('поля нет');
    field.value = 'в работе';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(world.written).toEqual([{ text: 'В РАБОТЕ' }]);
  });

  it('пишет выбранный цвет', () => {
    const world = render();
    badge().click();
    flushSync();
    host?.querySelector<HTMLButtonElement>('button[aria-label="Red"]')?.click();
    flushSync();
    expect(world.written).toEqual([{ color: 'red' }]);
  });

  it('открывается сам сразу после вставки и снимает отметку', () => {
    const world = render({ text: '', color: 'gray' }, { autoOpen: true });
    expect(host?.querySelector('[role="dialog"]')).not.toBeNull();
    expect(world.autoOpen).toBe(false);
  });

  it('убирает пустую метку при закрытии', () => {
    const world = render();
    badge().click();
    flushSync();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(world.deleted).toEqual([{ from: 5, to: 6 }]);
  });

  it('заполненную метку при закрытии оставляет', () => {
    const world = render({ text: 'ГОТОВО', color: 'green' });
    badge().click();
    flushSync();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(world.deleted).toEqual([]);
  });
});
