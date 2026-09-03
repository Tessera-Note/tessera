/**
 * Кнопки провайдеров на экране входа.
 *
 * Правила разбора адресов проверяются отдельно (`login.test.ts`), здесь —
 * разметка: что кнопка ведёт куда надо, что каталог спрашивает имя и пароль
 * на месте, и что при отказе провайдера человек видит причину.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SsoLogin from './SsoLogin.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;
let went: string[] = [];

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(SsoLogin, { target: host, props: props as never }) as Record<string, unknown>;
  flushSync();
  return host;
}

function buttons(): string[] {
  return [...(host?.querySelectorAll('[data-component="SsoLogin"] > div > button') ?? [])].map(
    (one) => (one.textContent ?? '').trim()
  );
}

beforeEach(() => {
  went = [];
  // Переход уводит браузер со страницы: в проверке он записывается, а не
  // выполняется — иначе среда проверок уходит вместе с ним.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return 'http://localhost/login';
      },
      set href(value: string) {
        went.push(value);
      }
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
  try {
    sessionStorage.clear();
  } catch {
    // Хранилища нет — очищать нечего.
  }
});

describe('SsoLogin', () => {
  it('без провайдеров не рисует ничего', () => {
    render({ workspace: { enforceSso: false, authProviders: [] } });
    expect(host?.querySelector('[data-component="SsoLogin"]')).toBeNull();
  });

  it('без сведений о пространстве не рисует ничего', () => {
    render({ workspace: null });
    expect(host?.querySelector('[data-component="SsoLogin"]')).toBeNull();
  });

  it('показывает кнопку на каждого провайдера с его именем', () => {
    render({
      workspace: {
        enforceSso: false,
        authProviders: [
          { id: 'p1', name: 'Контора', type: 'oidc' },
          { id: 'p2', name: 'Google', type: 'google' }
        ]
      }
    });
    expect(buttons()).toEqual(['Sign in with Контора', 'Sign in with Google']);
  });

  it('нажатие уводит на провайдера и несёт точку возврата', () => {
    render({
      workspace: { enforceSso: false, authProviders: [{ id: 'p1', name: 'К', type: 'oidc' }] },
      redirect: '/s/design'
    });
    host?.querySelector<HTMLButtonElement>('[data-component="SsoLogin"] > div > button')?.click();
    flushSync();
    expect(went).toEqual(['/api/sso/oidc/p1/login?redirect=%2Fs%2Fdesign']);
  });

  it('каталог не уводит, а спрашивает имя и пароль на месте', () => {
    render({
      workspace: { enforceSso: false, authProviders: [{ id: 'p3', name: 'Каталог', type: 'ldap' }] }
    });
    host?.querySelector<HTMLButtonElement>('[data-component="SsoLogin"] > div > button')?.click();
    flushSync();
    expect(went).toEqual([]);
    expect(host?.querySelector('form')).not.toBeNull();
    expect(host?.querySelector('input[autocomplete="username"]')).not.toBeNull();
  });

  it('уводит сам, когда провайдер один и вход через него обязателен', () => {
    render({
      workspace: { enforceSso: true, authProviders: [{ id: 'p1', name: 'К', type: 'oidc' }] }
    });
    expect(went).toEqual(['/api/sso/oidc/p1/login']);
  });

  it('после отказа провайдера не уводит, а называет причину', () => {
    render({
      workspace: { enforceSso: true, authProviders: [{ id: 'p1', name: 'К', type: 'oidc' }] },
      failed: true
    });
    expect(went).toEqual([]);
    expect(host?.textContent).toContain('Single sign-on failed');
  });

  it('второй раз подряд сам не уводит', () => {
    const workspace = { enforceSso: true, authProviders: [{ id: 'p1', name: 'К', type: 'oidc' }] };
    render({ workspace });
    expect(went).toHaveLength(1);

    if (component) void unmount(component);
    host?.remove();
    render({ workspace });
    expect(went).toHaveLength(1);
  });
});
