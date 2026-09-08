/**
 * Картинка человека.
 *
 * Проверяется разбор источника: имя файла превращается в адрес нашего
 * хранилища, внешний адрес остаётся собой, пустое значение даёт букву. Ошибка
 * здесь не падает, а показывает битую картинку у каждого участника.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Avatar from './Avatar.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(Avatar, { target: host, props }) as Record<string, unknown>;
  flushSync();
  return host;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('Avatar', () => {
  it('имя файла превращается в адрес хранилища', () => {
    const box = render({ src: 'aaa.png', name: 'Иван' });
    expect(box.querySelector('img')?.getAttribute('src')).toBe(
      '/api/attachments/img/avatar/aaa.png'
    );
  });

  it('внешний адрес остаётся собой', () => {
    // Так хранится картинка, пришедшая от провайдера входа: она лежит не у нас.
    const box = render({ src: 'https://example.com/a.png', name: 'Иван' });
    expect(box.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('без картинки показывает первую букву', () => {
    const box = render({ src: null, name: 'иван' });
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent?.trim()).toBe('И');
  });

  it('без имени показывает вопрос, а не пустоту', () => {
    const box = render({ src: null, name: null });
    expect(box.textContent?.trim()).toBe('?');
  });
});
