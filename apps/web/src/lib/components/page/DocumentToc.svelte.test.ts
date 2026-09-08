/**
 * Оглавление документа.
 *
 * Проверяются две вещи, которых не видно по типам: переход ведёт к тому же
 * заголовку, что назван в строке, и текущий раздел подсвечивается по
 * прокрутке. Пустые заголовки в документ попадают, а в перечень нет — на них
 * номера строк и разметки расходятся, и переход уводит не туда.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentToc from './DocumentToc.svelte';

let host: HTMLElement | null = null;
let body: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

/** Что отдаёт наблюдатель пересечений. Ставится проверкой вручную. */
let observed: Element[] = [];
let report: ((records: { isIntersecting: boolean; target: Element }[]) => void) | null = null;

function heading(level: number, text: string) {
  return {
    type: 'heading',
    attrs: { level },
    content: text ? [{ type: 'text', text }] : []
  };
}

function render(content: unknown, html: string): HTMLElement {
  host = document.createElement('div');
  body = document.createElement('div');
  body.innerHTML = html;
  document.body.append(host, body);
  component = mount(DocumentToc, {
    target: host,
    props: { content, body: () => body } as never
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function labels(box: HTMLElement): string[] {
  return [...box.querySelectorAll('button')].map((one) => (one.textContent ?? '').trim());
}

beforeEach(() => {
  observed = [];
  report = null;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(handler: (records: { isIntersecting: boolean; target: Element }[]) => void) {
        report = handler;
      }
      observe(node: Element) {
        observed.push(node);
      }
      disconnect() {}
      unobserve() {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (component) void unmount(component);
  host?.remove();
  body?.remove();
  component = null;
  host = null;
  body = null;
});

describe('DocumentToc', () => {
  it('без заголовков объясняет, чего не хватает', () => {
    const box = render({ type: 'doc', content: [] }, '<p>текст</p>');
    expect(box.textContent).toContain('Add headings to create a table of contents.');
  });

  it('переход ведёт к названному заголовку, а не к соседнему', () => {
    // Пустой заголовок есть в разметке и нет в перечне: без отбора номера
    // разошлись бы, и «Второй» уводил бы к первому.
    const content = {
      type: 'doc',
      content: [heading(1, 'Первый'), heading(2, ''), heading(2, 'Второй')]
    };
    const box = render(content, '<h1>Первый</h1><h2></h2><h2>Второй</h2>');
    expect(labels(box)).toEqual(['Первый', 'Второй']);

    const target = body?.querySelectorAll('h2')[1] as HTMLElement;
    const seen = vi.fn();
    target.scrollIntoView = seen;

    [...box.querySelectorAll('button')][1].click();
    expect(seen).toHaveBeenCalled();
  });

  it('следит только за непустыми заголовками', () => {
    render(
      { type: 'doc', content: [heading(1, 'Первый'), heading(2, ''), heading(2, 'Второй')] },
      '<h1>Первый</h1><h2></h2><h2>Второй</h2>'
    );
    expect(observed).toHaveLength(2);
  });

  it('подсвечивает раздел, дошедший до верха', () => {
    const box = render(
      { type: 'doc', content: [heading(1, 'Первый'), heading(2, 'Второй')] },
      '<h1>Первый</h1><h2>Второй</h2>'
    );

    report?.([{ isIntersecting: true, target: observed[1] }]);
    flushSync();

    const marked = [...box.querySelectorAll('button')].map((one) =>
      one.getAttribute('aria-current')
    );
    expect(marked).toEqual([null, 'true']);
  });
});
