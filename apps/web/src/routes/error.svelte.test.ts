/**
 * Страница отказа.
 *
 * Проверяется, что человек видит причину, а не одно число. Загрузчики отдают
 * код ошибки, и он обязан переводиться словарём; без кода остаётся сообщение
 * сервера, а без сообщения — общая фраза. Пустая страница с числом не
 * объясняет ничего и никуда не ведёт.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from '../test-stubs/app-state';
import { locale } from '$lib/stores/i18n.svelte';

const { default: ErrorPage } = await import('./+error.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(ErrorPage, { target: host }) as Record<string, unknown>;
  flushSync();
  return host;
}

beforeEach(() => {
  page.status = 404;
  page.error = null;
  locale.apply('en-US', {});
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
  locale.apply('en-US', {});
});

describe('страница отказа', () => {
  it('на 404 объясняет, куда делась страница, и даёт путь назад', () => {
    const box = render();

    expect(box.textContent).toContain('404');
    expect(box.textContent).toContain('Page not found');
    expect(box.textContent).toContain('This page may have been deleted');
    expect((box.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe('/home');
  });

  it('переводит код отказа словарём', () => {
    locale.apply('ru-RU', { 'error.page.page_not_found': 'Страница не найдена' });
    page.error = { code: 'error.page.page_not_found' };

    expect(render().textContent).toContain('Страница не найдена');
  });

  it('незнакомый код не показывается как есть', () => {
    // Ключ без перевода — это внутреннее имя. Человеку от него нет пользы,
    // и вместо него берётся объяснение по коду ответа.
    page.error = { code: 'error.page.unknown_thing' };

    const text = render().textContent ?? '';
    expect(text).not.toContain('error.page.unknown_thing');
    expect(text).toContain('This page may have been deleted');
  });

  it('без кода берётся сообщение сервера', () => {
    page.status = 500;
    page.error = { message: 'Сервер не ответил' };

    const box = render();
    expect(box.textContent).toContain('500');
    expect(box.textContent).toContain('Something went wrong');
    expect(box.textContent).toContain('Сервер не ответил');
  });

  it('без кода и сообщения остаётся общая фраза', () => {
    page.status = 500;
    page.error = null;

    expect(render().textContent).toContain('An unexpected error occurred');
  });
});
