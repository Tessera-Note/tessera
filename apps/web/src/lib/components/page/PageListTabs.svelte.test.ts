/**
 * Три перечня на главной и на экране пространства.
 *
 * Проверяется то, что различает строки: база и страница выглядят по-разному.
 * Без этого база в перечне неотличима от страницы, хотя открывается таблицей,
 * а безымянная база подписана как безымянная страница.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PageListTabs from './PageListTabs.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function listing(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    slugId: 'p1',
    title: 'Страница',
    icon: null,
    spaceId: 's1',
    spaceSlug: 'general',
    spaceName: 'General',
    updatedAt: null,
    createdAt: null,
    ...over
  };
}

function render(recent: Record<string, unknown>[]): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(PageListTabs, {
    target: host,
    props: { recent, favorites: [], mine: [] } as never
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('PageListTabs', () => {
  it('базе даёт свой значок', () => {
    const box = render([listing({ isBase: true })]);
    expect(box.textContent).toContain('🗄️');
    expect(box.textContent).not.toContain('📄');
  });

  it('обычной странице оставляет прежний', () => {
    const box = render([listing()]);
    expect(box.textContent).toContain('📄');
  });

  it('свой значок страницы важнее обоих', () => {
    const box = render([listing({ isBase: true, icon: '🚀' })]);
    expect(box.textContent).toContain('🚀');
    expect(box.textContent).not.toContain('🗄️');
  });

  it('безымянную базу подписывает базой', () => {
    const box = render([listing({ isBase: true, title: null })]);
    expect(box.textContent).toContain('Untitled base');
  });
});
