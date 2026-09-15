/**
 * Отказ службы редактирования в подключении.
 *
 * Сокет при отказе остаётся открытым, и без этого блока вкладка выглядит
 * исправной, хотя правки не уходят. Проверяется, что блок читается как тревога
 * и что кнопка действительно перезагружает страницу.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { default: ConnectionRefused } = await import('./ConnectionRefused.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(ConnectionRefused, { target: host, props: props as never }) as Record<
    string,
    unknown
  >;
  flushSync();
  return host;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('ConnectionRefused', () => {
  it('объявляет отказ тревогой, а не тихой строкой', () => {
    const box = render();
    const alert = box.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('This page is not syncing.');
  });

  it('кнопка перезагружает страницу', () => {
    const onreload = vi.fn();
    const box = render({ onreload });
    const button = [...box.querySelectorAll('button')].find(
      (one) => one.textContent?.trim() === 'Reload page'
    );
    expect(button).toBeDefined();
    button?.click();
    expect(onreload).toHaveBeenCalledTimes(1);
  });
});
