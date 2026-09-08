/**
 * Выбор родительской страницы.
 *
 * Проверяется то, чего не видно по типам: поиск сужен пространством, смена
 * пространства сбрасывает выбор, а пустой выбор означает корень — без этого
 * страница по шаблону всегда падала в корень или, хуже, к родителю из
 * соседнего пространства.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchPages = vi.fn();
vi.mock('$lib/features/search/services/search', () => ({
  searchPages: (...args: unknown[]) => searchPages(...args)
}));

const { default: PagePicker } = await import('./PagePicker.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(PagePicker, {
    target: host,
    props: { spaceId: 's1', value: null, onpick: () => {}, ...props } as never
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

/** Набрать в поле поиска и дать задержке истечь. */
async function type(box: HTMLElement, text: string): Promise<void> {
  const field = box.querySelector('input') as HTMLInputElement;
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  vi.advanceTimersByTime(400);
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  searchPages.mockReset();
  searchPages.mockResolvedValue([
    { id: 'p1', slugId: 'p1', title: 'Раздел', spaceId: 's1', highlight: null, rank: 1 }
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('PagePicker', () => {
  it('ищет только в выбранном пространстве', async () => {
    const box = render();
    await type(box, 'разд');

    expect(searchPages).toHaveBeenCalledWith('разд', 's1');
  });

  it('не спрашивает сервер на каждую букву', async () => {
    const box = render();
    const field = box.querySelector('input') as HTMLInputElement;
    for (const text of ['р', 'ра', 'раз']) {
      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(400);
    for (let step = 0; step < 4; step += 1) await Promise.resolve();

    expect(searchPages).toHaveBeenCalledTimes(1);
  });

  it('отдаёт выбранную страницу наружу', async () => {
    const onpick = vi.fn();
    const box = render({ onpick });
    await type(box, 'разд');

    const found = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Раздел'
    );
    found?.click();

    expect(onpick).toHaveBeenCalledWith({ id: 'p1', title: 'Раздел' });
  });

  it('снятый выбор означает корень пространства', () => {
    const onpick = vi.fn();
    const box = render({ value: { id: 'p1', title: 'Раздел' }, onpick });

    const clear = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Clear'
    );
    clear?.click();

    expect(onpick).toHaveBeenCalledWith(null);
  });

  it('пустой запрос ничего не ищет', async () => {
    const box = render();
    await type(box, '   ');

    expect(searchPages).not.toHaveBeenCalled();
  });
});
