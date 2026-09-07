/**
 * Экран пространства.
 *
 * Проверяется заведение базы: маршрут `bases/create` иначе достижим только
 * вставкой в страницу, и база как отдельная страница не заводилась ниоткуда.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls } from '../../../../test-stubs/app-navigation';

const createBase = vi.fn();
const createPage = vi.fn();
vi.mock('$lib/features/base/services/bases', () => ({
  createBase: (...args: unknown[]) => createBase(...args)
}));
vi.mock('$lib/features/page/services/pages', () => ({
  createPage: (...args: unknown[]) => createPage(...args)
}));
vi.mock('$lib/features/space/services/spaces', () => ({
  watchSpace: () => Promise.resolve({ isWatching: true }),
  unwatchSpace: () => Promise.resolve({ isWatching: false })
}));

const { default: SpacePage } = await import('./+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(SpacePage, {
    target: host,
    props: {
      data: {
        space: { id: 's1', name: 'Общее', slug: 'general', description: null },
        favoriteSpaces: [],
        watching: { isWatching: false, isMuted: false },
        recent: [],
        favorites: [],
        mine: []
      } as never
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function button(box: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  createBase.mockReset();
  createBase.mockResolvedValue({ id: 'b1' });
  createPage.mockReset();
  createPage.mockResolvedValue({ slugId: 'pg1' });
  calls.goto.length = 0;
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('экран пространства', () => {
  it('заводит базу в этом пространстве и открывает её', async () => {
    const box = render();

    button(box, 'New base')?.click();
    await settle();

    expect(createBase).toHaveBeenCalledWith({ spaceId: 's1' });
    expect(calls.goto).toContain('/base/b1');
  });

  it('страница по-прежнему заводится страницей', async () => {
    const box = render();

    button(box, 'New page')?.click();
    await settle();

    expect(createPage).toHaveBeenCalledWith({ spaceId: 's1' });
    expect(calls.goto).toContain('/s/general/p/pg1');
  });
});
