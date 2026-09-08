/**
 * Экран метки.
 *
 * Проверяется продолжение перечня. Выдача постраничная, и страница бывает
 * короче запрошенной: права выбрасывают строки уже после выборки. Поэтому
 * конец перечня показывает пустой курсор, а не короткая страница — и кнопка
 * продолжения обязана появляться по курсору, а не по числу строк.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pagesWithLabel = vi.fn();
vi.mock('$lib/features/page/services/labels', () => ({
  pagesWithLabel: (...args: unknown[]) => pagesWithLabel(...args)
}));

const { default: LabelPage } = await import('./+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function row(id: string, title: string) {
  return { id, slugId: id, title, icon: null, spaceSlug: 'general', spaceName: 'Общее' };
}

function render(over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(LabelPage, {
    target: host,
    props: {
      data: { name: 'Регламент', pages: [row('p1', 'Первая')], nextCursor: 'к1', ...over } as never
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

/** Названия страниц перечня. Имя пространства идёт второй строкой ссылки. */
function titles(box: HTMLElement): string[] {
  return [...box.querySelectorAll('[data-component="LabelledPages"] a span:first-child')].map(
    (one) => (one.textContent ?? '').trim()
  );
}

function button(box: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  pagesWithLabel.mockReset();
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('экран метки', () => {
  it('догружает следующую страницу и дописывает её в перечень', async () => {
    pagesWithLabel.mockResolvedValue({ items: [row('p2', 'Вторая')], meta: { nextCursor: null } });
    const box = render();

    button(box, 'Load more')?.click();
    await settle();

    expect(pagesWithLabel).toHaveBeenCalledWith({ name: 'Регламент', cursor: 'к1' });
    expect(titles(box)).toEqual(['Первая', 'Вторая']);
    // Курсор кончился — предлагать продолжение больше нечем.
    expect(button(box, 'Load more')).toBeUndefined();
  });

  it('без курсора продолжения не предлагает', () => {
    const box = render({ nextCursor: null });
    expect(button(box, 'Load more')).toBeUndefined();
  });

  it('пустая страница с курсором продолжение оставляет', async () => {
    // Права выбросили все строки страницы. Конец перечня показывает курсор, а
    // не пустота: иначе часть страниц с меткой не увидел бы никто.
    pagesWithLabel.mockResolvedValue({ items: [], meta: { nextCursor: 'к2' } });
    const box = render();

    button(box, 'Load more')?.click();
    await settle();

    expect(titles(box)).toEqual(['Первая']);
    expect(button(box, 'Load more')).toBeDefined();
  });

  it('отказ догрузки виден и перечень не теряется', async () => {
    pagesWithLabel.mockRejectedValue(new Error('сеть'));
    const box = render();

    button(box, 'Load more')?.click();
    await settle();

    expect(titles(box)).toEqual(['Первая']);
    expect(box.querySelector('[role="alert"], [data-component="Notice"]')).not.toBeNull();
  });
});
