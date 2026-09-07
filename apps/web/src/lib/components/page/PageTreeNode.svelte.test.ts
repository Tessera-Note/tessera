/**
 * Строка дерева страниц.
 *
 * Проверяется отступ ветви. Дочерние строки лежат внутри родительской, и отступ
 * по глубине складывался с родительским: на восьмом уровне ветвь уходила за
 * край панели, у строки оставался значок, а название сжималось в ничто.
 * Найдено на ввезённой выгрузке Notion, где такая глубина обычна.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PageTreeNode from './PageTreeNode.svelte';
import type { PageSummary } from '$lib/features/page/services/pages';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function page(id: string, title: string): PageSummary {
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

function render(depth: number, node: PageSummary = page('p1', 'Страница')): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(PageTreeNode, {
    target: host,
    props: {
      node,
      spaceSlug: 'general',
      depth,
      activeSlug: undefined,
      ancestors: new Set<string>(),
      siblings: [],
      spaces: [],
      favorites: new Set<string>(),
      onchanged: () => {},
      onfavorites: () => {}
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function indent(box: HTMLElement): string {
  const node = box.querySelector<HTMLElement>('[data-component="PageTreeNode"]');
  return node?.style.paddingLeft ?? '';
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('PageTreeNode', () => {
  it('корень не отступает', () => {
    expect(indent(render(0))).toBe('0px');
  });

  it('отступ одинаков на любой глубине', () => {
    // Шаг, а не сумма: родительский отступ строка уже получила вложенностью.
    expect(indent(render(1))).toBe('12px');
    expect(indent(render(8))).toBe('12px');
  });

  it('название страницы показано', () => {
    const box = render(3);
    expect(box.querySelector('a')?.textContent).toContain('Страница');
  });

  it('база отличается значком', () => {
    // Открывается она таблицей, а не редактором: одинаковый значок обещал бы
    // строке дерева не то, что за ней стоит.
    const box = render(0, { ...page('b1', 'Проекты'), isBase: true });
    expect(box.querySelector('a')?.textContent).toContain('🗄️');
  });

  it('безымянную базу подписывает базой', () => {
    const box = render(0, { ...page('b1', ''), title: null, isBase: true });
    expect(box.querySelector('a')?.textContent).toContain('Untitled base');
  });
});
