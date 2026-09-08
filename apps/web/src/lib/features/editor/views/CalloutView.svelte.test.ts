/**
 * Выноска.
 *
 * Вид и значок лежат в документе, а не в отображении, поэтому проверяются
 * вызванные команды расширения. Через них же вид и правится: они сверяют
 * значение со списком допустимых, и запись атрибута мимо них положила бы в
 * документ вид, которого не знает ни разбор разметки, ни вывоз.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import CalloutView from './CalloutView.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

type World = { kinds: string[]; icons: string[]; selections: number[] };

function render(
  attributes: Record<string, unknown> = { type: 'info', icon: null },
  options: { editable?: boolean } = {}
): World {
  const world: World = { kinds: [], icons: [], selections: [] };
  const chain = () => {
    const link = {
      setTextSelection: (at: number) => {
        world.selections.push(at);
        return link;
      },
      updateCalloutType: (kind: string) => {
        world.kinds.push(kind);
        return link;
      },
      updateCalloutIcon: (icon: string) => {
        world.icons.push(icon);
        return link;
      },
      run: () => true
    };
    return link;
  };

  host = document.createElement('div');
  host.setAttribute('data-node-view', 'callout');
  document.body.appendChild(host);
  component = mount(CalloutView, {
    target: host,
    props: {
      node: {} as never,
      attributes,
      selected: false,
      editable: options.editable ?? true,
      editor: { chain } as never,
      updateAttributes: () => {},
      position: () => 12
    }
  }) as Record<string, unknown>;
  flushSync();
  return world;
}

function frame(): HTMLElement {
  const found = host?.firstElementChild as HTMLElement | null;
  if (!found) throw new Error('рамки нет');
  return found;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('CalloutView', () => {
  it('красит рамку по виду', () => {
    render({ type: 'danger', icon: null });
    expect(frame().className).toContain('rose');
  });

  it('неизвестный вид показывает как сведения', () => {
    render({ type: 'default', icon: null });
    expect(frame().className).toContain('sky');
  });

  it('оставляет место содержимому редактора', () => {
    render();
    expect(host?.querySelector('[data-node-view-content]')).not.toBeNull();
  });

  it('свой значок вытесняет значок вида', () => {
    render({ type: 'info', icon: '🔥' });
    expect(host?.textContent).toContain('🔥');
    expect(host?.querySelector('svg')).toBeNull();
  });

  it('в чтении вид не меняется', () => {
    render({ type: 'info', icon: null }, { editable: false });
    expect(host?.querySelector('button')).toBeNull();
  });

  it('пишет выбранный вид командой расширения', () => {
    const world = render();
    host?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')?.click();
    flushSync();
    const dialog = host?.querySelector('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('button[aria-label="Success"]')?.click();
    flushSync();
    expect(world.kinds).toEqual(['success']);
    // Правка идёт по месту узла, а не по нынешней каретке: она может стоять
    // где угодно, и команда ушла бы не в ту выноску.
    expect(world.selections).toEqual([13]);
  });

  it('закрывает выбор нажатием мимо', () => {
    render();
    host?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')?.click();
    flushSync();
    expect(host?.querySelector('[role="dialog"]')).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(host?.querySelector('[role="dialog"]')).toBeNull();
  });
});
