/**
 * Показ присутствия.
 *
 * Проверяется то, что видит человек: пустого ряда нет вовсе, лишние прячутся
 * за счётчик, а перечень открывается нажатием и закрывается щелчком мимо.
 * Разбор самих сведений проверен отдельно (`features/editor/presence.test.ts`).
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { Present } from '$lib/features/editor/presence';
import PagePresence from './PagePresence.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function person(name: string, id = name): Present {
  return { id, name, color: 'hsl(10 70% 55%)', avatarUrl: null, tabs: 1 };
}

function render(people: Present[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(PagePresence, { target: host, props: { people } }) as Record<string, unknown>;
  flushSync();
  return host;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('PagePresence', () => {
  it('пустой перечень не занимает места на экране', () => {
    // Ряд аватарок без единого человека означал бы «никого нет» местом, и это
    // место занималось бы всегда.
    const box = render([]);
    expect(box.querySelector('[data-component="PagePresence"]')).toBeNull();
  });

  it('показывает аватарки присутствующих', () => {
    const box = render([person('Анна'), person('Пётр')]);
    expect(box.querySelectorAll('[data-component="Avatar"]')).toHaveLength(2);
  });

  it('лишние уходят за счётчик', () => {
    // Ряд не резиновый: пятый и дальше считаются.
    const box = render(['Анна', 'Борис', 'Вера', 'Глеб', 'Дина'].map((one) => person(one)));
    expect(box.querySelectorAll('[data-component="Avatar"]')).toHaveLength(4);
    expect(box.textContent).toContain('+1');
  });

  it('нажатие открывает перечень с именами', () => {
    const box = render([person('Анна'), person('Пётр')]);
    expect(box.querySelector('[role="menu"]')).toBeNull();

    box.querySelector('button')?.click();
    flushSync();

    const menu = box.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Анна');
    expect(menu?.textContent).toContain('Пётр');
  });

  it('щелчок мимо закрывает перечень', () => {
    const box = render([person('Анна')]);
    box.querySelector('button')?.click();
    flushSync();
    expect(box.querySelector('[role="menu"]')).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(box.querySelector('[role="menu"]')).toBeNull();
  });

  it('несколько вкладок одного человека названы', () => {
    // Иначе одна запись читается как один открытый лист, а их у человека два.
    const box = render([{ ...person('Анна'), tabs: 2 }]);
    box.querySelector('button')?.click();
    flushSync();
    expect(box.querySelector('[role="menu"]')?.textContent).toContain('2');
  });
});
