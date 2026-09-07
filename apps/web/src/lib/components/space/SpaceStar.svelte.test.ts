/**
 * Звезда пространства.
 *
 * Проверяется, что нажатие уходит тем видом отметки, который ждёт сервер, и в
 * ту сторону, в какой отметка сейчас стоит. Вид передаётся полем `type`: без
 * него общий маршрут считает отметку страничной и отказывает — «нужен
 * идентификатор страницы».
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('$lib/api/client', () => ({
  post: (...args: unknown[]) => post(...args),
  get: () => Promise.resolve([]),
  ApiError: class extends Error {}
}));

const { default: SpaceStar } = await import('./SpaceStar.svelte');
const { calls } = await import('../../../test-stubs/app-navigation');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(SpaceStar, {
    target: host,
    props: { spaceId: 's1', name: 'Общее', favorited: false, ...props }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

/** Дать нажатию дойти до конца: обращение к серверу приходит обещанием. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ status: 'ok' });
  calls.invalidateAll = 0;
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('SpaceStar', () => {
  it('отмечает пространство видом «space»', async () => {
    const box = render();
    box.querySelector('button')?.click();
    await settle();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/api/favorites/add');
    expect(post.mock.calls[0][1]).toEqual({ type: 'space', spaceId: 's1' });
  });

  it('снимает отметку, когда она уже стоит', async () => {
    const box = render({ favorited: true });
    box.querySelector('button')?.click();
    await settle();

    expect(post.mock.calls[0][0]).toBe('/api/favorites/remove');
    expect(post.mock.calls[0][1]).toEqual({ type: 'space', spaceId: 's1' });
  });

  it('перечитывает данные: отметка видна сразу в трёх местах', async () => {
    const box = render();
    box.querySelector('button')?.click();
    await settle();

    expect(calls.invalidateAll).toBe(1);
  });

  it('называет пространство в имени для чтения с экрана', () => {
    const box = render({ name: 'Общее' });
    const button = box.querySelector('button');
    // Звёзд на экране столько же, сколько строк: одинаковая подпись у всех
    // оставляет читающего с экрана без единого различия между ними.
    expect(button?.getAttribute('aria-label')).toContain('Общее');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
  });

  it('сообщает об отказе тому, кто её показывает', async () => {
    post.mockRejectedValue(new Error('нет связи'));
    let told: string | null = null;
    const box = render({ onfailure: (message: string) => (told = message) });
    box.querySelector('button')?.click();
    await settle();

    expect(told).not.toBeNull();
    // Кнопка снова доступна: иначе один отказ выключает её до перезагрузки.
    expect(box.querySelector('button')?.disabled).toBe(false);
  });
});
