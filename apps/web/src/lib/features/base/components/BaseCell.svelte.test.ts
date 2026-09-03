/**
 * Ячейка базы.
 *
 * Проверяется главное: вид свойства решает, каким средством ячейку правят, и
 * что уходит наружу. Ошибка здесь тихая — поле показывается, а записывается не
 * то или ничего.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BaseCell from './BaseCell.svelte';
import type { BaseProperty } from '../services/bases';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function property(over: Partial<BaseProperty> = {}): BaseProperty {
  return {
    id: 'p1',
    name: 'Поле',
    type: 'text',
    position: 'a',
    typeOptions: null,
    isPrimary: false,
    ...over
  } as BaseProperty;
}

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(BaseCell, {
    target: host,
    props: {
      property: property(),
      value: null,
      context: {},
      editable: true,
      people: [],
      onwrite: () => {},
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

describe('BaseCell', () => {
  it('текст правится полем ввода', () => {
    const onwrite = vi.fn();
    const box = render({ value: 'было', onwrite });

    const input = box.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('было');

    input.value = 'стало';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    expect(onwrite).toHaveBeenCalledWith('стало');
  });

  it('пустое поле очищает ячейку, а не пишет пустую строку', () => {
    // База отличает «нет значения» от «пустая строка»: отбор «не заполнено»
    // иначе не находил бы очищенную ячейку.
    const onwrite = vi.fn();
    const box = render({ value: 'было', onwrite });

    const input = box.querySelector('input') as HTMLInputElement;
    input.value = '   ';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    expect(onwrite).toHaveBeenCalledWith(null);
  });

  it('число уходит числом', () => {
    const onwrite = vi.fn();
    const box = render({ property: property({ type: 'number' }), value: 1, onwrite });

    const input = box.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('number');
    input.value = '42';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    expect(onwrite).toHaveBeenCalledWith(42);
  });

  it('флажок уходит признаком', () => {
    const onwrite = vi.fn();
    const box = render({ property: property({ type: 'checkbox' }), value: false, onwrite });

    const input = box.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('checkbox');
    input.click();
    flushSync();

    expect(onwrite).toHaveBeenCalledWith(true);
  });

  it('выбор показывает варианты по именам, а пишет их идентификаторы', () => {
    const onwrite = vi.fn();
    const box = render({
      property: property({
        type: 'select',
        typeOptions: {
          choices: [
            { id: 'c1', name: 'Готово' },
            { id: 'c2', name: 'В работе' }
          ],
          choiceOrder: ['c2', 'c1']
        }
      }),
      value: 'c1',
      onwrite
    });

    const select = box.querySelector('select') as HTMLSelectElement;
    // Порядок задан `choiceOrder`, первым идёт пустой вариант.
    expect([...select.options].map((one) => one.textContent?.trim())).toEqual([
      '—',
      'В работе',
      'Готово'
    ]);
    expect(select.value).toBe('c1');

    select.value = 'c2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(onwrite).toHaveBeenCalledWith('c2');
  });

  it('множественный выбор переключает значения, не затирая остальные', () => {
    const onwrite = vi.fn();
    const box = render({
      property: property({
        type: 'multiSelect',
        typeOptions: {
          choices: [
            { id: 'c1', name: 'Один' },
            { id: 'c2', name: 'Два' }
          ]
        }
      }),
      value: ['c1'],
      onwrite
    });

    const buttons = [...box.querySelectorAll('button')];
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');

    buttons[1].click();
    flushSync();
    expect(onwrite).toHaveBeenCalledWith(['c1', 'c2']);
  });

  it('человек выбирается из участников пространства', () => {
    const box = render({
      property: property({ type: 'person' }),
      value: 'u1',
      people: [
        { id: 'u1', name: 'Пётр' },
        { id: 'u2', name: 'Анна' }
      ],
      context: { people: { u1: { id: 'u1', name: 'Пётр', avatarUrl: null } } }
    });

    const select = box.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((one) => one.textContent?.trim())).toEqual([
      '—',
      'Пётр',
      'Анна'
    ]);
    expect(select.value).toBe('u1');
  });

  it('вычисляемое свойство показывается, но не правится', () => {
    // Значение ставит сервер: поле ввода обещало бы правку, которую он
    // отвергает.
    const box = render({
      property: property({ type: 'createdBy' }),
      value: 'u1',
      context: { people: { u1: { id: 'u1', name: 'Пётр', avatarUrl: null } } }
    });

    expect(box.querySelector('input')).toBeNull();
    expect(box.querySelector('select')).toBeNull();
    expect(box.textContent).toContain('Пётр');
  });

  it('без права правки ячейка только показывается', () => {
    const box = render({ value: 'текст', editable: false });
    expect(box.querySelector('input')).toBeNull();
    expect(box.textContent).toContain('текст');
  });

  it('пустая ячейка без права правки показывает прочерк, а не пустоту', () => {
    const box = render({ value: null, editable: false });
    expect(box.textContent?.trim()).toBe('—');
  });
});
