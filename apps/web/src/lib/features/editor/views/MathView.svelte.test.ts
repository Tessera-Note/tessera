/**
 * Формула.
 *
 * KaTeX здесь настоящая: подменять её нечем — проверяется именно то, что
 * разобранная формула превращается в разметку, а неразобранная не роняет
 * отрисовку, а показывает отказ.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import MathView from './MathView.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

type World = { written: Record<string, unknown>[]; deleted: { from: number; to: number }[] };

function render(
  attributes: Record<string, unknown> = { text: 'E = mc^2' },
  options: { display?: boolean; selected?: boolean; editable?: boolean } = {}
): World {
  const world: World = { written: [], deleted: [] };
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
  component = mount(MathView, {
    target: host,
    props: {
      node: { nodeSize: 1 },
      attributes,
      selected: options.selected ?? false,
      editable: options.editable ?? true,
      editor: { commands: { focus: () => true }, chain },
      updateAttributes: (values: Record<string, unknown>) => world.written.push(values),
      position: () => 7,
      display: options.display ?? false
    } as never
  }) as Record<string, unknown>;
  flushSync();
  return world;
}

function frame(): HTMLElement {
  const found = host?.querySelector<HTMLElement>('[data-component="MathView"]');
  if (!found) throw new Error('формулы нет');
  return found;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('MathView', () => {
  it('рисует разобранную формулу разметкой KaTeX', () => {
    render({ text: 'E = mc^2' });
    expect(frame().querySelector('.katex')).not.toBeNull();
    expect(frame().className).not.toContain('tessera-math-error');
  });

  it('строчная формула лежит в строке, блочная — отдельной строкой', () => {
    render({ text: 'x' }, { display: false });
    expect(frame().tagName).toBe('SPAN');
    if (component) void unmount(component);
    host?.remove();
    render({ text: 'x' }, { display: true });
    expect(frame().tagName).toBe('DIV');
    expect(frame().className).toContain('tessera-math-block');
  });

  it('пустая формула зовёт заполнить', () => {
    render({ text: '   ' });
    expect(frame().textContent).toContain('Empty equation');
    expect(frame().className).toContain('tessera-math-empty');
  });

  it('неразобранная формула показывает отказ, а не роняет отрисовку', () => {
    render({ text: '\\frac{1}' });
    expect(frame().textContent).toContain('Invalid equation');
    expect(frame().className).toContain('tessera-math-error');
  });

  it('выделение узла открывает правку и заводит поле набранным', () => {
    render({ text: 'a+b' }, { selected: true });
    const field = host?.querySelector<HTMLTextAreaElement>('textarea');
    expect(field).not.toBeNull();
    expect(field?.value).toBe('a+b');
  });

  it('в чтении выделение правку не открывает', () => {
    render({ text: 'a+b' }, { selected: true, editable: false });
    expect(host?.querySelector('textarea')).toBeNull();
  });

  it('кнопка удаления есть только у блочной формулы', () => {
    render({ text: 'a' }, { selected: true, display: false });
    expect(host?.querySelector('button')).toBeNull();
    if (component) void unmount(component);
    host?.remove();
    const world = render({ text: 'a' }, { selected: true, display: true });
    host?.querySelector<HTMLButtonElement>('button')?.click();
    flushSync();
    expect(world.deleted).toEqual([{ from: 7, to: 8 }]);
  });
});
