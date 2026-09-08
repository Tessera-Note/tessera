/**
 * Ручка блока.
 *
 * Схема и документ здесь настоящие: проверяется разбор позиции под указателем,
 * а он опирается на `resolve` и глубину узла. На поддельном документе проверка
 * ничего не значила бы — именно на глубине ручка и ломалась.
 */

import { Schema } from '@tiptap/pm/model';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import DragHandle from './DragHandle.svelte';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    quote: { group: 'block', content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    heading: { group: 'block', content: 'text*' },
    text: {}
  }
});

/**
 * Документ: абзац, заголовок, цитата с абзацем внутри.
 *
 * Позиции: абзац 0, заголовок 8, цитата 19, абзац в цитате 20.
 */
const doc = schema.node('doc', null, [
  schema.node('paragraph', null, [schema.text('первый')]),
  schema.node('heading', null, [schema.text('заголовок')]),
  schema.node('quote', null, [schema.node('paragraph', null, [schema.text('внутри')])])
]);

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function fakeEditor(coords: { pos: number; inside: number } | null) {
  const block = document.createElement('div');
  document.body.appendChild(block);
  return {
    isEditable: true,
    state: { doc },
    view: {
      posAtCoords: () => coords,
      nodeDOM: () => block
    }
  } as never;
}

function render(coords: { pos: number; inside: number } | null): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(DragHandle, {
    target: host,
    props: { editor: fakeEditor(coords), oninsert: () => {} }
  }) as Record<string, unknown>;
  flushSync();
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 40 }));
  flushSync();
  return host;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('DragHandle', () => {
  it('показывает ручку у блока под указателем', () => {
    // 10 — внутри заголовка, который начинается в позиции 8.
    const box = render({ pos: 10, inside: 8 });
    const handle = box.querySelector('[data-component="DragHandle"]');
    expect(handle).not.toBeNull();
    expect(handle?.querySelectorAll('button')).toHaveLength(2);
  });

  it('поднимается до блока верхнего уровня из вложенного', () => {
    // 22 — внутри абзаца, который лежит в цитате: ручка принадлежит цитате.
    const box = render({ pos: 22, inside: 20 });
    expect(box.querySelector('[data-component="DragHandle"]')).not.toBeNull();
  });

  it('молчит, когда под указателем нет узла', () => {
    const box = render(null);
    expect(box.querySelector('[data-component="DragHandle"]')).toBeNull();
  });

  it('молчит на позиции между блоками верхнего уровня', () => {
    // 8 — стык абзаца и заголовка, глубина нулевая, поднимать неоткуда.
    const box = render({ pos: 8, inside: -1 });
    expect(box.querySelector('[data-component="DragHandle"]')).toBeNull();
  });
});
