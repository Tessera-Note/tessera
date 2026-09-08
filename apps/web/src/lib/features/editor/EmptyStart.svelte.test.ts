/**
 * Подсказка на пустой странице.
 *
 * Это единственный способ превратить страницу в базу: маршрут `bases/convert`
 * иначе недостижим. Проверяется, что оба чипа просят разное — «Канбан» без
 * шаблона дал бы таблицу вместо доски, — и что уход идёт на экран базы: сама
 * страница после превращения открывается пустым редактором.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls } from '../../../test-stubs/app-navigation';

const convertToBase = vi.fn();
vi.mock('$lib/features/base/services/bases', () => ({
  convertToBase: (...args: unknown[]) => convertToBase(...args)
}));

const { default: EmptyStart } = await import('./EmptyStart.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(EmptyStart, {
    target: host,
    props: { pageId: 'pg1', ...props } as never
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function chip(box: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  convertToBase.mockReset();
  convertToBase.mockResolvedValue({ id: 'pg1' });
  calls.goto.length = 0;
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('EmptyStart', () => {
  it('заводит таблицу без шаблона', async () => {
    const box = render();
    chip(box, 'Base')?.click();
    await settle();

    expect(convertToBase).toHaveBeenCalledWith('pg1', undefined);
    expect(calls.goto).toContain('/base/pg1');
  });

  it('заводит доску по шаблону', async () => {
    const box = render();
    chip(box, 'Kanban')?.click();
    await settle();

    expect(convertToBase).toHaveBeenCalledWith('pg1', 'kanban');
  });

  it('отказ отдаётся наружу, а не теряется', async () => {
    convertToBase.mockRejectedValue(new Error('нет связи'));
    const onfailure = vi.fn();
    const box = render({ onfailure });
    chip(box, 'Base')?.click();
    await settle();

    expect(onfailure).toHaveBeenCalled();
    expect(calls.goto).toEqual([]);
  });
});
