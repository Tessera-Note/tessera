/**
 * Меню строки дерева.
 *
 * Главное здесь — что показано и кому: действия правки не должны появляться у
 * того, кто править не может, а перенос — там, где переносить некуда.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PageMenu from './PageMenu.svelte';
import type { Space } from '$lib/features/space/services/spaces';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

const spaces: Space[] = [
  { id: 's1', name: 'Свой', slug: 'own', description: null, role: 'admin' },
  { id: 's2', name: 'Соседний', slug: 'other', description: null, role: 'member' }
];

function render(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(PageMenu, {
    target: host,
    props: {
      canEdit: true,
      spaces,
      spaceId: 's1',
      busy: false,
      onsubpage: () => {},
      onduplicate: () => {},
      onmove: () => {},
      ondelete: () => {},
      onclose: () => {},
      ...props
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function labels(box: HTMLElement): string[] {
  return [...box.querySelectorAll('[role="menuitem"]')].map((one) =>
    (one.textContent ?? '').trim()
  );
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('PageMenu', () => {
  it('показывает действия правки тому, кто правит', () => {
    const box = render();
    const found = labels(box);
    expect(found).toHaveLength(4);
    expect(found.join(' ')).toContain('New subpage');
    expect(found.join(' ')).toContain('Duplicate');
    expect(found.join(' ')).toContain('Delete');
  });

  it('без права правки не показывает ни одного действия', () => {
    // Кнопка, которая всегда отказывает, хуже её отсутствия.
    const box = render({ canEdit: false });
    expect(labels(box)).toHaveLength(0);
    expect(box.textContent).toContain('permission');
  });

  it('перенос не предлагается, когда переносить некуда', () => {
    // В перечне остаётся только своё пространство: переносить в него незачем.
    const box = render({ spaces: [spaces[0]] });
    expect(labels(box).join(' ')).not.toContain('Move to space');
  });

  it('перечень пространств не показывает своё', () => {
    const box = render();
    const move = [...box.querySelectorAll('[role="menuitem"]')].find((one) =>
      (one.textContent ?? '').includes('Move to space')
    ) as HTMLElement;
    move.click();
    flushSync();

    const targets = labels(box).filter((one) => one === 'Соседний' || one === 'Свой');
    expect(targets).toEqual(['Соседний']);
  });

  it('выбор пространства сообщает его имя', () => {
    const onmove = vi.fn();
    const box = render({ onmove });

    const move = [...box.querySelectorAll('[role="menuitem"]')].find((one) =>
      (one.textContent ?? '').includes('Move to space')
    ) as HTMLElement;
    move.click();
    flushSync();

    const target = [...box.querySelectorAll('[role="menuitem"]')].find(
      (one) => (one.textContent ?? '').trim() === 'Соседний'
    ) as HTMLElement;
    target.click();
    flushSync();

    expect(onmove).toHaveBeenCalledWith('s2');
  });

  it('закрывается по нажатию вне меню и по Escape', () => {
    // Окно без выхода остаётся висеть, и следующее нажатие уходит в него.
    const onclose = vi.fn();
    render({ onclose });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(onclose).toHaveBeenCalled();

    onclose.mockClear();
    window.dispatchEvent(new Event('pointerdown'));
    flushSync();
    expect(onclose).toHaveBeenCalled();
  });

  it('нажатие внутри меню его не закрывает', () => {
    const onclose = vi.fn();
    const box = render({ onclose });

    const menu = box.querySelector('[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    flushSync();

    expect(onclose).not.toHaveBeenCalled();
  });

  it('во время работы действия не нажимаются', () => {
    const box = render({ busy: true });
    for (const one of box.querySelectorAll('[role="menuitem"]')) {
      expect((one as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
