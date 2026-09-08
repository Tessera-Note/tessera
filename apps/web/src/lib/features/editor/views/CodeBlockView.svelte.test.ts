/**
 * Блок кода и диаграмма.
 *
 * Диаграмма живёт в том же узле, что и код: у неё нет своего узла схемы, это
 * блок кода с языком `mermaid`. Поэтому оба предмета проверяются здесь.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeBlockView from './CodeBlockView.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

type World = { written: Record<string, unknown>[]; listeners: number };

function render(
  attributes: Record<string, unknown>,
  text: string,
  options: { editable?: boolean } = {}
): World {
  const world: World = { written: [], listeners: 0 };
  const handlers = new Set<() => void>();

  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(CodeBlockView, {
    target: host,
    props: {
      node: { nodeSize: text.length + 2, textContent: text },
      attributes,
      selected: false,
      editable: options.editable ?? true,
      editor: {
        state: { selection: { from: 500, to: 500 } },
        on: (_event: string, fn: () => void) => {
          handlers.add(fn);
          world.listeners = handlers.size;
        },
        off: (_event: string, fn: () => void) => {
          handlers.delete(fn);
          world.listeners = handlers.size;
        }
      },
      updateAttributes: (values: Record<string, unknown>) => world.written.push(values),
      position: () => 10,
      languages: () => ['python', 'javascript', 'bash']
    } as never
  }) as Record<string, unknown>;
  flushSync();
  return world;
}

function view(): HTMLElement {
  const found = host?.querySelector<HTMLElement>('[data-component="CodeBlockView"]');
  if (!found) throw new Error('блока нет');
  return found;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('CodeBlockView', () => {
  it('оставляет место содержимому редактора и помечает язык', () => {
    render({ language: 'python' }, 'print(1)');
    const slot = view().querySelector('[data-node-view-content]');
    expect(slot).not.toBeNull();
    expect(slot?.className).toBe('language-python');
  });

  it('перечень языков берётся у расширения, а не свой', () => {
    render({ language: 'python' }, 'print(1)');
    const options = [...view().querySelectorAll('option')].map((one) => one.value);
    // Первый — пустой, «язык не выбран».
    expect(options).toEqual(['', 'bash', 'javascript', 'python']);
  });

  it('выбор языка пишется в узел', () => {
    const world = render({ language: 'python' }, 'print(1)');
    const select = view().querySelector('select');
    if (!select) throw new Error('выбора нет');
    select.value = 'bash';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(world.written).toEqual([{ language: 'bash' }]);
  });

  it('в чтении язык не меняется', () => {
    render({ language: 'python' }, 'print(1)', { editable: false });
    expect(view().querySelector('select')?.disabled).toBe(true);
  });

  it('копирование кладёт в буфер текст узла и отмечается', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) }
    });
    render({ language: 'python' }, 'print(1)');
    view().querySelector<HTMLButtonElement>('button')?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(view().querySelector('button')?.getAttribute('aria-label')).toBe('Copied');
    });
    expect(written).toEqual(['print(1)']);
  });

  it('отписывается от событий редактора при разборе', () => {
    const world = render({ language: 'python' }, 'print(1)');
    expect(world.listeners).toBe(1);
    if (component) void unmount(component);
    component = null;
    flushSync();
    expect(world.listeners).toBe(0);
  });

  it('обычный блок кода диаграммой не рисуется', () => {
    render({ language: 'python' }, 'print(1)');
    expect(view().querySelector('.tessera-mermaid')).toBeNull();
  });

  it('диаграмма рисуется библиотекой и прячет исходный текст', async () => {
    vi.doMock('mermaid', () => ({
      default: {
        initialize: () => {},
        render: () => Promise.resolve({ svg: '<svg data-drawn="1"></svg>' })
      }
    }));
    render({ language: 'mermaid' }, 'graph TD;\n A-->B;');
    await vi.waitFor(() => {
      flushSync();
      expect(view().querySelector('.tessera-mermaid svg[data-drawn]')).not.toBeNull();
    });
    expect(view().querySelector('pre')?.hidden).toBe(true);
    vi.doUnmock('mermaid');
  });

  it('неразобранная диаграмма называет причину правящему', async () => {
    vi.doMock('mermaid', () => ({
      default: {
        initialize: () => {},
        render: () => Promise.reject(new Error('Parse error on line 1'))
      }
    }));
    render({ language: 'mermaid' }, 'не диаграмма');
    await vi.waitFor(() => {
      flushSync();
      expect(view().querySelector('[role="alert"]')?.textContent).toContain('Parse error');
    });
    vi.doUnmock('mermaid');
  });
});
