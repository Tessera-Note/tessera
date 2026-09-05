/**
 * Кнопка копирования.
 *
 * Проверяется то, ради чего она заведена: кнопка отвечает, что случилось.
 * Молчаливое копирование неотличимо от несостоявшегося — в незащищённом
 * соединении буфера у браузера нет вовсе.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CopyButton from './CopyButton.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function withClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', {
    value,
    configurable: true,
    writable: true
  });
}

function render(props: Record<string, unknown> = {}): HTMLButtonElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(CopyButton, {
    target: host,
    props: { text: 'ссылка', ...props }
  }) as Record<string, unknown>;
  flushSync();
  return host.querySelector('button') as HTMLButtonElement;
}

/** Нажать и дождаться ответа буфера. */
async function press(button: HTMLButtonElement) {
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
  withClipboard(undefined);
  vi.restoreAllMocks();
});

describe('CopyButton', () => {
  it('после успеха говорит, что скопировано', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard({ writeText });

    const button = render();
    await press(button);

    expect(writeText).toHaveBeenCalledWith('ссылка');
    expect(button.textContent?.trim()).toBe('Copied');
  });

  it('после отказа говорит об отказе, а не молчит', async () => {
    withClipboard(undefined);

    const button = render();
    await press(button);

    expect(button.textContent?.trim()).toBe('Copying failed');
  });

  it('своя подпись в спокойном состоянии', () => {
    const button = render({ label: 'Copy link' });
    expect(button.textContent?.trim()).toBe('Copy link');
  });
});
