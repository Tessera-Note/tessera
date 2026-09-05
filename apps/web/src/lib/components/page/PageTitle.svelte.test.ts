/**
 * Название страницы.
 *
 * Правится на месте, как в v1 (`features/editor/title-editor.tsx`). Отдельный
 * режим «Переименовать» с полем и двумя кнопками расходился с v1 и требовал
 * трёх действий там, где хватает щелчка.
 *
 * Проверяется то, что легко сломать молча: сохранение с задержкой, а не на
 * каждую букву; сохранение при уходе ввода; Enter не переводит строку.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PageTitle from './PageTitle.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const saved: string[] = [];
  component = mount(PageTitle, {
    target: host,
    props: {
      title: 'Регламент',
      editable: true,
      onsave: (value: string) => saved.push(value),
      ...props
    }
  }) as Record<string, unknown>;
  flushSync();
  return { box: host, saved };
}

function type(box: HTMLElement, text: string) {
  const field = box.querySelector('textarea') as HTMLTextAreaElement;
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return field;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
  vi.useRealTimers();
});

describe('PageTitle', () => {
  it('показывает название полем правки', () => {
    const { box } = render();
    expect((box.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Регламент');
  });

  it('без права правки поле не даётся', () => {
    const { box } = render({ editable: false });
    expect(box.querySelector('textarea')).toBeNull();
    expect(box.textContent?.trim()).toBe('Регламент');
  });

  it('сохраняет с задержкой, а не на каждую букву', () => {
    const { box, saved } = render();
    type(box, 'Регламен');
    type(box, 'Регламент 2');
    expect(saved).toEqual([]);

    vi.advanceTimersByTime(600);
    expect(saved).toEqual(['Регламент 2']);
  });

  it('уход ввода сохраняет сразу', () => {
    const { box, saved } = render();
    const field = type(box, 'Другое');
    field.dispatchEvent(new Event('blur', { bubbles: true }));
    flushSync();
    expect(saved).toEqual(['Другое']);
  });

  it('прежнее значение не сохраняется заново', () => {
    const { box, saved } = render();
    const field = type(box, 'Регламент');
    field.dispatchEvent(new Event('blur', { bubbles: true }));
    vi.advanceTimersByTime(600);
    expect(saved).toEqual([]);
  });

  it('Enter не переводит строку, а уводит дальше', () => {
    let left = 0;
    const { box, saved } = render({ onleave: () => (left += 1) });
    const field = type(box, 'Новое');

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    flushSync();

    expect(event.defaultPrevented).toBe(true);
    expect(saved).toEqual(['Новое']);
    expect(left).toBe(1);
  });
});
