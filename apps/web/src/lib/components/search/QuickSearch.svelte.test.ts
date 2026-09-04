/**
 * Быстрый поиск поверх экрана.
 *
 * Проверяется то, ради чего он заведён: поиск идёт по мере набора, выдача
 * водится стрелками, Enter открывает выбранное. В v1 это самый частый способ
 * попасть на страницу (`Spotlight`, `mod+K`).
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuickSearch from './QuickSearch.svelte';
import * as search from '$lib/features/search/services/search';
import type { Space } from '$lib/features/space/services/spaces';

// Подмена перехода живёт в подпорке среды, а не в объявлении модуля: тип
// настоящего `$app/navigation` записи вызовов не знает.
const { calls } = await import('../../../test-stubs/app-navigation');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

const spaces: Space[] = [
  { id: 's1', name: 'Общее', slug: 'general', description: null, role: 'admin' }
];

const found = [
  { id: 'p1', slugId: 'aaa', title: 'Регламент', spaceId: 's1', highlight: null, rank: 1 },
  { id: 'p2', slugId: 'bbb', title: 'Расписание', spaceId: 's1', highlight: null, rank: 0.5 }
];

function render(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(QuickSearch, {
    target: host,
    props: { spaces, open: true, onclose: () => {} }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

/** Ожидание задержки перед запросом плюс сам запрос. */
async function settle() {
  await vi.advanceTimersByTimeAsync(400);
  flushSync();
}

function type(box: HTMLElement, text: string) {
  const field = box.querySelector('input') as HTMLInputElement;
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return field;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(search, 'searchPages').mockResolvedValue(found);
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  calls.goto.length = 0;
});

describe('QuickSearch', () => {
  it('ищет по мере набора, не на каждую букву', async () => {
    const box = render();
    type(box, 'рег');
    type(box, 'регл');

    expect(search.searchPages).not.toHaveBeenCalled();
    await settle();

    expect(search.searchPages).toHaveBeenCalledTimes(1);
    expect(box.textContent).toContain('Регламент');
  });

  it('показывает пространство у строки', async () => {
    const box = render();
    type(box, 'рег');
    await settle();

    expect(box.textContent).toContain('Общее');
  });

  it('стрелки водят по выдаче, Enter открывает выбранное', async () => {
    const box = render();
    const field = type(box, 'рег');
    await settle();

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flushSync();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(calls.goto).toEqual(['/s/general/p/bbb']);
  });

  it('пустой запрос ничего не спрашивает', async () => {
    const box = render();
    type(box, '   ');
    await settle();

    expect(search.searchPages).not.toHaveBeenCalled();
  });
});
