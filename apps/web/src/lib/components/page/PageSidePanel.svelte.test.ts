/**
 * Правая панель страницы.
 *
 * Проверяется то, ради чего перечень обратных ссылок отделили от счёта: он
 * тянет проверку прав по каждой странице-источнику, а вкладка закрыта, пока её
 * не открыли. Со страницей приходит только число — им и подписана вкладка.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backlinksOf = vi.fn();
vi.mock('$lib/features/page/services/backlinks', () => ({
  backlinksOf: (...args: unknown[]) => backlinksOf(...args)
}));

// Обсуждение тянет за собой редактор целиком; панели здесь важны вкладки.
vi.mock('./PageComments.svelte', async () => ({
  default: (await import('../../../test-stubs/ReadyProbe.svelte')).default
}));
vi.mock('$lib/features/realtime/socket', () => ({ onRealtime: () => () => {} }));

const { default: PageSidePanel } = await import('./PageSidePanel.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(PageSidePanel, {
    target: host,
    props: {
      pageId: 'pg1',
      spaceId: 's1',
      spaceSlug: 'general',
      versions: [],
      labels: [],
      backlinkCount: 0,
      permission: null,
      verification: null,
      share: null,
      comments: [],
      onclose: () => {},
      ...over
    } as never
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function tab(box: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('nav button')].find((one) =>
    (one.textContent ?? '').trim().startsWith(label)
  ) as HTMLButtonElement | undefined;
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  backlinksOf.mockReset();
  backlinksOf.mockResolvedValue([
    { id: 'pg2', slugId: 'abc', title: 'Соседняя', icon: null, spaceId: 's1' }
  ]);
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('PageSidePanel', () => {
  it('счёт стоит на самой вкладке', () => {
    const box = render({ backlinkCount: 3 });
    expect(tab(box, 'Backlinks')?.textContent?.trim()).toBe('Backlinks (3)');
  });

  it('без ссылок числа на вкладке нет', () => {
    const box = render();
    expect(tab(box, 'Backlinks')?.textContent?.trim()).toBe('Backlinks');
  });

  it('перечень не запрашивается, пока вкладка закрыта', () => {
    render({ backlinkCount: 3 });
    expect(backlinksOf).not.toHaveBeenCalled();
  });

  it('перечень читается при открытии вкладки и один раз', async () => {
    const box = render({ backlinkCount: 1 });

    tab(box, 'Backlinks')?.click();
    await settle();
    expect(backlinksOf).toHaveBeenCalledWith('pg1');
    expect(box.textContent).toContain('Соседняя');

    tab(box, 'Labels')?.click();
    flushSync();
    tab(box, 'Backlinks')?.click();
    await settle();
    expect(backlinksOf).toHaveBeenCalledTimes(1);
  });
});
