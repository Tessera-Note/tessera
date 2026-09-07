/**
 * Дерево страниц в боковой панели.
 *
 * Проверяется то, что видно глазами и не видно типам: дерево не перезагружается
 * от перехода внутри того же пространства. Довод приходит из перечня, который
 * слой пересобирает на каждый переход, и без сверки эффект перезапускался —
 * дерево ставило «загрузка» и на сотню миллисекунд пропадало с экрана.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from '../../../test-stubs/app-state';

const pageTree = vi.fn();
const breadcrumbs = vi.fn();
vi.mock('$lib/features/page/services/pages', () => ({
  pageTree: (...args: unknown[]) => pageTree(...args),
  breadcrumbs: (...args: unknown[]) => breadcrumbs(...args)
}));
vi.mock('$lib/features/page/services/favorites', () => ({
  favoritePageIds: () => Promise.resolve([])
}));
vi.mock('$lib/features/space/services/spaces', () => ({ listSpaces: () => Promise.resolve([]) }));
vi.mock('$lib/features/realtime/socket', () => ({ onRealtime: () => () => {} }));

const { default: PageTree } = await import('./PageTree.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function node(id: string, title: string) {
  return {
    id,
    slugId: id,
    title,
    icon: null,
    parentPageId: null,
    spaceId: 's1',
    hasChildren: false,
    canEdit: true
  };
}

/** Свойства объектом состояния: слой передаёт их заново на каждый переход. */
function render(): { box: HTMLElement; props: Record<string, unknown> } {
  host = document.createElement('div');
  document.body.appendChild(host);
  const props = $state({ spaceId: 's1', spaceSlug: 'general' });
  component = mount(PageTree, { target: host, props: props as never }) as Record<string, unknown>;
  flushSync();
  return { box: host, props };
}

async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
  flushSync();
}

function titles(box: HTMLElement): string[] {
  return [...box.querySelectorAll('[data-component="PageTreeNode"] a')].map((one) =>
    (one.textContent ?? '').trim()
  );
}

beforeEach(() => {
  pageTree.mockReset();
  pageTree.mockResolvedValue([node('p1', 'Первая'), node('p2', 'Вторая')]);
  breadcrumbs.mockReset();
  breadcrumbs.mockResolvedValue([]);
  page.params = {};
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('PageTree', () => {
  it('загружает корень пространства один раз', async () => {
    const { box } = render();
    await settle();

    expect(pageTree).toHaveBeenCalledTimes(1);
    expect(titles(box)).toHaveLength(2);
  });

  it('переход внутри пространства не перезагружает дерево', async () => {
    const { box, props } = render();
    await settle();
    expect(pageTree).toHaveBeenCalledTimes(1);

    // Слой отдаёт те же значения новым объектом: так выглядит переход по
    // ссылке дерева. Дерево при этом обязано остаться на экране.
    page.params = { spaceSlug: 'general', pageSlug: 'p1' };
    props.spaceId = 's1';
    props.spaceSlug = 'general';
    await settle();

    expect(pageTree).toHaveBeenCalledTimes(1);
    expect(titles(box)).toHaveLength(2);
    expect(box.textContent).not.toContain('Loading...');
  });

  it('смена пространства перезагружает дерево', async () => {
    // Строки прежнего пространства к новому не относятся.
    const { props } = render();
    await settle();

    pageTree.mockResolvedValue([node('p3', 'Третья')]);
    props.spaceId = 's2';
    await settle();

    expect(pageTree).toHaveBeenCalledTimes(2);
    expect(pageTree).toHaveBeenLastCalledWith('s2', null);
  });
});
