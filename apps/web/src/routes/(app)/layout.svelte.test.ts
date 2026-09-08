/**
 * Шапка приложения.
 *
 * Проверяется имя в левом верхнем углу. Там стоит имя продукта, а не название
 * рабочего пространства: название читалось как имя приложения — на стенде в
 * углу было «Проверка v2», и понять по нему, что открыта Tessera, было нельзя.
 * Так же устроена первая версия (`components/layouts/global/app-header.tsx`).
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/features/realtime/socket', () => ({
  onRealtime: () => () => {},
  sendRealtime: () => Promise.resolve()
}));
vi.mock('$lib/components/page/PageTree.svelte', async () => ({
  default: (await import('../../test-stubs/ReadyProbe.svelte')).default
}));
vi.mock('$lib/components/search/QuickSearch.svelte', async () => ({
  default: (await import('../../test-stubs/ReadyProbe.svelte')).default
}));
vi.mock('$lib/features/auth/services/auth', () => ({ logout: () => Promise.resolve() }));
vi.mock('$lib/features/ai/services/chat', () => ({
  deleteChat: () => Promise.resolve({}),
  listChats: () => Promise.resolve({ items: [], nextCursor: null }),
  renameChat: () => Promise.resolve({})
}));

const { default: AppLayout } = await import('./+layout.svelte');
const { default: emptyChildren } = await import('../../test-stubs/EmptyChildren.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(AppLayout, {
    target: host,
    props: {
      data: {
        session: {
          user: { id: 'u1', name: 'Кто-то', role: 'admin' },
          workspace: { id: 'w1', name: 'Проверка v2', logo: null }
        },
        spaces: [],
        chats: { items: [], nextCursor: null },
        favoriteSpaces: [],
        unread: 0,
        ...over
      },
      // Слой рисует вложенное содержимое: без него `{@render children()}`
      // отказывает, и до шапки дело не доходит.
      children: emptyChildren
    } as never
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

/** Ссылка на главную и есть имя в углу. */
function brand(box: HTMLElement): string {
  const link = [...box.querySelectorAll('a')].find((one) => one.getAttribute('href') === '/home');
  return (link?.textContent ?? '').trim();
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('шапка приложения', () => {
  it('в углу стоит имя продукта', () => {
    const box = render();
    expect(brand(box)).toBe('Tessera');
  });

  it('название рабочего пространства именем приложения не становится', () => {
    // Ровно то, что было видно на стенде: в углу стояло «Проверка v2».
    const box = render();
    expect(brand(box)).not.toContain('Проверка v2');
  });

  it('значок рабочего пространства остаётся рядом', () => {
    // Его меняют в настройках, и показывать его больше негде.
    const box = render({
      session: {
        user: { id: 'u1', name: 'Кто-то', role: 'admin' },
        workspace: { id: 'w1', name: 'Проверка v2', logo: 'значок.png' }
      }
    });
    const link = [...box.querySelectorAll('a')].find((one) => one.getAttribute('href') === '/home');
    expect(link?.querySelector('img')).not.toBeNull();
  });
});
