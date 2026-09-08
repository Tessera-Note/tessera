/**
 * Мост между Tiptap и отображением на Svelte.
 *
 * Главная проверка — правка атрибутов. Отображение живёт дольше одного узла:
 * Tiptap зовёт `update` при каждой правке, а исходный узел остаётся снимком на
 * миг создания. Правка поверх этого снимка возвращала записанное после неё, и
 * вторая правка стирала первую.
 */

import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import StatusView from './views/StatusView.svelte';
import { svelteNodeView } from './node-view.svelte';

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

/**
 * Редактор в объёме, который трогает мост.
 *
 * Узел держится здесь и подменяется на каждой правке — так же, как его держит
 * настоящий документ. Иначе проверка ничего не сказала бы: снимок и документ
 * расходятся именно после первой правки.
 */
function fakeEditor() {
  let current: PMNode = schema.node('status', { text: '', color: 'gray' });
  let refresh: (node: PMNode) => void = () => {};
  let editable = true;
  const listeners = new Set<() => void>();

  const chain = () => {
    const tr = {
      doc: { nodeAt: () => current },
      setNodeMarkup: (_position: number, _type: unknown, attrs: Record<string, unknown>) => {
        current = schema.node('status', attrs);
      }
    };
    const link = {
      focus: () => link,
      deleteRange: () => link,
      command: (run: (props: { tr: unknown }) => boolean) => {
        run({ tr });
        return link;
      },
      run: () => {
        refresh(current);
        return true;
      }
    };
    return link;
  };

  return {
    editor: {
      get isEditable() {
        return editable;
      },
      storage: { status: { autoOpen: false } },
      commands: { focus: () => true },
      chain,
      on: (_event: string, fn: () => void) => listeners.add(fn),
      off: (_event: string, fn: () => void) => listeners.delete(fn)
    },
    node: () => current,
    onRefresh: (fn: (node: PMNode) => void) => (refresh = fn),
    /** Переключить режим так же, как это делает `setEditable`: событием, без правки узла. */
    setEditable: (value: boolean) => {
      editable = value;
      for (const fn of listeners) fn();
    },
    listeners: () => listeners.size
  };
}

let view: { destroy?: () => void } | null = null;
let host: HTMLElement | null = null;

function render() {
  const world = fakeEditor();
  const renderer = svelteNodeView(StatusView as never, { inline: true })({
    node: world.node(),
    editor: world.editor as never,
    getPos: () => 5
  } as never) as { dom: HTMLElement; update: (node: PMNode) => boolean; destroy: () => void };

  world.onRefresh((node) => renderer.update(node));
  view = renderer;
  host = document.createElement('div');
  host.appendChild(renderer.dom);
  document.body.appendChild(host);
  flushSync();
  return { renderer, world };
}

function badge(): HTMLElement {
  const found = host?.querySelector<HTMLElement>('[data-component="StatusView"]');
  if (!found) throw new Error('метки нет');
  return found;
}

afterEach(() => {
  view?.destroy?.();
  host?.remove();
  view = null;
  host = null;
});

describe('svelteNodeView', () => {
  it('оборачивает строчный узел строчной обёрткой', () => {
    const { renderer } = render();
    expect(renderer.dom.tagName).toBe('SPAN');
    expect(renderer.dom.getAttribute('data-node-view')).toBe('status');
  });

  it('вторая правка атрибутов не стирает первую', () => {
    const { world } = render();

    badge().click();
    flushSync();
    const field = host?.querySelector<HTMLInputElement>('input');
    if (!field) throw new Error('поля нет');
    field.value = 'в работе';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(world.node().attrs.text).toBe('В РАБОТЕ');

    const green = host?.querySelector<HTMLButtonElement>('button[aria-label="Green"]');
    green?.click();
    flushSync();

    expect(world.node().attrs).toEqual({ text: 'В РАБОТЕ', color: 'green' });
  });

  it('узнаёт о смене режима без правки узла', () => {
    const { world } = render();
    expect(host?.querySelector('button')).not.toBeNull();
    world.setEditable(false);
    flushSync();
    expect(host?.querySelector('button')).toBeNull();
  });

  it('уход в чтение закрывает открытую правку', () => {
    const { world } = render();
    host?.querySelector<HTMLButtonElement>('[data-component="StatusView"]')?.click();
    flushSync();
    expect(host?.querySelector('[role="dialog"]')).not.toBeNull();
    world.setEditable(false);
    flushSync();
    expect(host?.querySelector('[role="dialog"]')).toBeNull();
  });

  it('отписывается при разборе', () => {
    const { renderer, world } = render();
    expect(world.listeners()).toBe(1);
    renderer.destroy();
    view = null;
    expect(world.listeners()).toBe(0);
  });

  it('перерисовывает отображение по новому узлу', () => {
    const { renderer } = render();
    renderer.update(schema.node('status', { text: 'ГОТОВО', color: 'green' }));
    flushSync();
    expect(badge().textContent?.trim()).toBe('ГОТОВО');
  });
});
