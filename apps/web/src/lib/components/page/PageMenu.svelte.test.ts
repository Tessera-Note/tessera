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
      favorite: false,
      onsubpage: () => {},
      onduplicate: () => {},
      oncopy: () => {},
      onmove: () => {},
      onfavorite: () => {},
      oncopylink: () => {},
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
    const found = labels(box).join(' ');
    expect(found).toContain('New subpage');
    expect(found).toContain('Duplicate');
    expect(found).toContain('Copy to space');
    expect(found).toContain('Move to space');
    expect(found).toContain('Delete');
  });

  it('читателю остаются только отметка и ссылка, и названа причина', () => {
    // Ни та, ни другая страницу не меняют. Кнопка, которая всегда отказывает,
    // хуже её отсутствия — правки в перечне нет. Пустое место под ссылкой при
    // этом читается как поломка меню, поэтому причина названа словами.
    const box = render({ canEdit: false });
    const found = labels(box);
    expect(found).toEqual(['Add to favorites', 'Copy link']);
    expect(box.textContent).toContain('You do not have permission to perform this action');
  });

  it('закрашенная звезда означает снятие отметки', () => {
    const box = render({ favorite: true });
    expect(labels(box)).toContain('Remove from favorites');
  });

  it('копия в пространство сообщает его имя', () => {
    const oncopy = vi.fn();
    const box = render({ oncopy });

    const copy = [...box.querySelectorAll('[role="menuitem"]')].find((one) =>
      (one.textContent ?? '').includes('Copy to space')
    ) as HTMLElement;
    copy.click();
    flushSync();

    const target = [...box.querySelectorAll('[role="menuitem"]')].find(
      (one) => (one.textContent ?? '').trim() === 'Соседний'
    ) as HTMLElement;
    target.click();

    expect(oncopy).toHaveBeenCalledWith('s2');
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

  it('удаление спрашивает и только потом уносит страницу', () => {
    // Пункт стоит последним, соседи выше безобидны: без вопроса промах уносил
    // бы страницу вместе с потомками одним нажатием.
    const ondelete = vi.fn();
    const box = render({ ondelete });

    const item = [...box.querySelectorAll('[role="menuitem"]')].find(
      (one) => (one.textContent ?? '').trim() === 'Delete'
    ) as HTMLElement;
    item.click();
    flushSync();

    expect(ondelete).not.toHaveBeenCalled();
    expect(box.textContent).toContain('Move this page to trash?');
    // Срока хранения здесь нет намеренно: он настраивается в рабочем
    // пространстве, а меню дерева его не знает.
    expect(box.textContent).not.toContain('permanently deleted');

    const confirm = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Move to trash'
    ) as HTMLElement;
    confirm.click();

    expect(ondelete).toHaveBeenCalledTimes(1);
  });

  it('отказ от удаления возвращает пункт меню', () => {
    const ondelete = vi.fn();
    const box = render({ ondelete });

    const item = [...box.querySelectorAll('[role="menuitem"]')].find(
      (one) => (one.textContent ?? '').trim() === 'Delete'
    ) as HTMLElement;
    item.click();
    flushSync();

    const cancel = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Cancel'
    ) as HTMLElement;
    cancel.click();
    flushSync();

    expect(ondelete).not.toHaveBeenCalled();
    expect(box.textContent).not.toContain('Move this page to trash?');
    expect(labels(box)).toContain('Delete');
  });

  it('во время работы действия не нажимаются', () => {
    const box = render({ busy: true });
    for (const one of box.querySelectorAll('[role="menuitem"]')) {
      expect((one as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
