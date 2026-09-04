/**
 * Экран поиска.
 *
 * Проверяется одно: запрос живёт в адресе. Иначе адрес обещает больше, чем
 * делает — показывает `?q=…`, а открытая по нему страница пуста, и видит это
 * только тот, кто такой ссылкой поделился или обновил вкладку.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchPages = vi.fn();
vi.mock('$lib/features/search/services/search', () => ({
  searchPages: (...args: unknown[]) => searchPages(...args)
}));

const { default: SearchPage } = await import('./+page.svelte');
const { page } = await import('../../../test-stubs/app-state');
const { calls } = await import('../../../test-stubs/app-navigation');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(SearchPage, {
    target: host,
    props: { data: { spaces: [{ id: 's1', slug: 'general' }] } as never }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

/** Дать поиску дойти до показа: ответ приходит обещанием. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  searchPages.mockReset();
  searchPages.mockResolvedValue([]);
  calls.goto.length = 0;
  page.url = new URL('http://localhost/search');
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('Экран поиска', () => {
  it('открытый по ссылке с запросом ищет сам', async () => {
    page.url = new URL('http://localhost/search?q=%D0%BE%D1%82%D1%87%D1%91%D1%82');
    searchPages.mockResolvedValue([
      { id: 'p1', slugId: 'abc', spaceId: 's1', title: 'Отчёт', highlight: null }
    ]);

    const box = render();
    await settle();

    expect(searchPages).toHaveBeenCalledWith('отчёт');
    expect(box.textContent).toContain('Отчёт');
  });

  it('подставляет запрос из адреса в поле', async () => {
    page.url = new URL('http://localhost/search?q=%D0%BE%D1%82%D1%87%D1%91%D1%82');
    const box = render();
    await settle();

    expect(box.querySelector('input')?.value).toBe('отчёт');
  });

  it('без запроса в адресе ничего не спрашивает', async () => {
    render();
    await settle();
    expect(searchPages).not.toHaveBeenCalled();
  });

  it('отправка правит адрес, а не ищет сама', async () => {
    const box = render();
    const field = box.querySelector('input') as HTMLInputElement;

    field.value = 'отчёт';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    box
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    // Один путь: ищет только тот, кто прочитал адрес. Иначе поиск шёл бы
    // дважды — от отправки и от смены адреса.
    expect(calls.goto[0]).toBe('/search?q=%D0%BE%D1%82%D1%87%D1%91%D1%82');
    expect(searchPages).not.toHaveBeenCalled();
  });

  it('пустой запрос адрес не трогает', async () => {
    const box = render();
    box
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(calls.goto).toHaveLength(0);
  });
});
