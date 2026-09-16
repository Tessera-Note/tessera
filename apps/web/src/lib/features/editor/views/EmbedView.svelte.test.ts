/**
 * Встроенный ролик.
 *
 * Узел рисовался ссылкой: и вставленный адрес, и пункт меню давали строку, по
 * которой надо уходить на сторонний сайт. Здесь проверяется, что он
 * показывается проигрывателем, а пустой — полем для адреса.
 */

import { flushSync, mount, unmount } from 'svelte';
import { printSheet } from '$lib/stores/print.svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { default: EmbedView } = await import('./EmbedView.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function show(attrs: Record<string, unknown>, editable = true) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const updateAttributes = vi.fn();
  component = mount(EmbedView, {
    target: host,
    props: { node: { attrs }, editor: { isEditable: editable }, updateAttributes }
  }) as Record<string, unknown>;
  flushSync();
  return { updateAttributes };
}

afterEach(() => {
  if (component) unmount(component);
  host?.remove();
  component = null;
  host = null;
  printSheet.active = false;
});

describe('встроенный ролик', () => {
  it('с адресом показывается проигрывателем, а не ссылкой', () => {
    show({ src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', provider: 'youtube' });

    const frame = host?.querySelector('iframe');
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(host?.querySelector('a')).toBeNull();
  });

  it('окно ограничено в правах', () => {
    // Встроенная страница чужая: давать ей всё подряд незачем. Полноэкранный
    // показ оставлен — ради него ролик и встраивают.
    show({ src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', provider: 'youtube' });

    const frame = host?.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(frame?.hasAttribute('allowfullscreen')).toBe(true);
    expect(frame?.getAttribute('loading')).toBe('lazy');
  });

  it('чужая схема адреса до окна не доходит', () => {
    // Узел заводится и правкой документа, и вставкой; адрес обязан пройти
    // очистку в самом отображении, а не только там, где его записали.
    show({ src: 'javascript:alert(1)', provider: 'youtube' });

    const frame = host?.querySelector('iframe');
    expect(frame?.getAttribute('src') ?? '').not.toContain('javascript:');
  });

  it('пустой узел просит адрес', () => {
    // Пункт меню заводит узел без адреса, и без поля заполнить его нечем.
    const { updateAttributes } = show({ src: '', provider: 'youtube' });

    const field = host?.querySelector('input');
    expect(field).toBeTruthy();

    field!.value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    field!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    host?.querySelector('button')?.click();
    flushSync();

    expect(updateAttributes).toHaveBeenCalledWith(expect.objectContaining({ provider: 'youtube' }));
    const [passed] = updateAttributes.mock.calls[0] as [{ src: string }];
    expect(passed.src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });

  it('в режиме чтения поля ввода нет', () => {
    show({ src: '', provider: 'youtube' }, false);

    expect(host?.querySelector('input')).toBeNull();
  });

  it('на листе печати вместо окна стоят название и адрес', () => {
    // Окно чужого сайта в печати не загружается, и на листе оставалась пустая
    // рамка в половину страницы. Читать по бумаге нечего, а адрес переносит
    // читателя туда, где ролик есть.
    printSheet.active = true;
    show({ src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', provider: 'youtube' });

    expect(host?.querySelector('iframe')).toBeNull();
    const link = host?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(host?.textContent).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
});
