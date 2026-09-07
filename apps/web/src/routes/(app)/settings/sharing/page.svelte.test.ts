/**
 * Экран открытых ссылок.
 *
 * Проверяется продолжение перечня. Экран заводят ради вопроса «что из нашего
 * сейчас открыто наружу», и оборванный на потолке выдачи перечень отвечает на
 * него неверно — молча и убедительно.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listShares = vi.fn();
vi.mock('$lib/features/share/services/list', () => ({
  listShares: (...args: unknown[]) => listShares(...args)
}));
vi.mock('$lib/features/share/services/share', () => ({
  revokeShare: () => Promise.resolve({ success: true })
}));

const { default: SharingPage } = await import('./+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function row(id: string, title: string) {
  return {
    id,
    key: `key-${id}`,
    includeSubPages: false,
    searchIndexing: false,
    createdAt: '2026-01-01T00:00:00Z',
    pageId: `pg-${id}`,
    pageTitle: title,
    pageSlugId: id,
    spaceSlug: 'general',
    spaceName: 'Общее',
    creatorName: 'Хозяин',
    creatorAvatarUrl: null
  };
}

function render(over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(SharingPage, {
    target: host,
    props: { data: { shares: [row('s1', 'Первая')], nextCursor: 'к1', ...over } as never }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function rows(box: HTMLElement): number {
  return box.querySelectorAll('[data-component="ShareList"] > li').length;
}

function button(box: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  listShares.mockReset();
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('экран открытых ссылок', () => {
  it('догружает следующую страницу', async () => {
    listShares.mockResolvedValue({ items: [row('s2', 'Вторая')], meta: { nextCursor: null } });
    const box = render();

    button(box, 'Load more')?.click();
    await settle();

    expect(listShares).toHaveBeenCalledWith({ cursor: 'к1' });
    expect(rows(box)).toBe(2);
    expect(box.textContent).toContain('Вторая');
    expect(button(box, 'Load more')).toBeUndefined();
  });

  it('без курсора продолжения не предлагает', () => {
    const box = render({ nextCursor: null });
    expect(button(box, 'Load more')).toBeUndefined();
  });

  it('пустая страница с курсором продолжение оставляет', async () => {
    // Права выбросили все строки страницы: конец перечня показывает курсор.
    listShares.mockResolvedValue({ items: [], meta: { nextCursor: 'к2' } });
    const box = render();

    button(box, 'Load more')?.click();
    await settle();

    expect(rows(box)).toBe(1);
    expect(button(box, 'Load more')).toBeDefined();
  });
});
