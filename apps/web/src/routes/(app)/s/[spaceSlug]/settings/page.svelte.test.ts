/**
 * Настройки пространства.
 *
 * Проверяется единственное необратимое действие экрана. Пространство уносит
 * все свои страницы, обсуждения и вложения, и двух нажатий здесь мало: они
 * защищают от промаха, но не от «удаляю не то пространство». Поэтому название
 * набирается руками, как в первой версии.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls } from '../../../../../test-stubs/app-navigation';

const deleteSpace = vi.fn();
vi.mock('$lib/features/space/services/spaces', async () => {
  const real = await vi.importActual<Record<string, unknown>>(
    '$lib/features/space/services/spaces'
  );
  return { ...real, deleteSpace: (...args: unknown[]) => deleteSpace(...args) };
});

const { default: SpaceSettings } = await import('./+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

const space = {
  id: 's1',
  name: 'Общее',
  slug: 'general',
  description: null,
  role: 'admin',
  logo: null,
  defaultRole: 'writer',
  disablePublicSharing: false,
  allowViewerComments: false
};

function render(over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(SpaceSettings, {
    target: host,
    props: { data: { space, members: [], ...over } as never }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function button(box: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
}

function field(box: HTMLElement): HTMLInputElement {
  return box.querySelector('[data-component="DeleteSpace"] input') as HTMLInputElement;
}

/** Набрать название так, как это делает человек. */
function type(box: HTMLElement, value: string): void {
  const input = field(box);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  deleteSpace.mockReset();
  deleteSpace.mockResolvedValue({ success: true });
  calls.goto.length = 0;
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('настройки пространства', () => {
  it('удаляет после набранного названия и уводит на главную', async () => {
    const box = render();

    button(box, 'Delete space')?.click();
    flushSync();
    expect(deleteSpace).not.toHaveBeenCalled();

    type(box, 'Общее');
    button(box, 'Confirm')?.click();
    await settle();

    expect(deleteSpace).toHaveBeenCalledWith('s1');
    expect(calls.goto).toContain('/home');
  });

  it('название набирается без учёта регистра и краевых пробелов', async () => {
    // Человек переписывает название глазами, и разница в регистре — не та
    // ошибка, от которой здесь защищаются.
    const box = render();

    button(box, 'Delete space')?.click();
    flushSync();
    type(box, '  общее ');
    button(box, 'Confirm')?.click();
    await settle();

    expect(deleteSpace).toHaveBeenCalledWith('s1');
  });

  it('другое название не удаляет и говорит почему', async () => {
    const box = render();

    button(box, 'Delete space')?.click();
    flushSync();
    type(box, 'Другое');
    button(box, 'Confirm')?.click();
    await settle();

    expect(deleteSpace).not.toHaveBeenCalled();
    expect(box.textContent).toContain('Names do not match');
  });

  it('пустое поле не удаляет', async () => {
    // Отдельно от неверного названия: пустое поле — это «нажал, не читая».
    const box = render();

    button(box, 'Delete space')?.click();
    flushSync();
    button(box, 'Confirm')?.click();
    await settle();

    expect(deleteSpace).not.toHaveBeenCalled();
  });

  it('отказ закрывает вопрос и очищает набранное', () => {
    const box = render();

    button(box, 'Delete space')?.click();
    flushSync();
    type(box, 'Общее');
    button(box, 'Cancel')?.click();
    flushSync();

    expect(box.querySelector('[data-component="DeleteSpace"]')).toBeNull();

    button(box, 'Delete space')?.click();
    flushSync();
    expect(field(box).value).toBe('');
  });

  it('название пространства названо в самом вопросе', () => {
    // Иначе набирать нечего: человек пришёл на экран по ссылке и мог не
    // помнить, как называется то пространство, что он открыл.
    const box = render();

    button(box, 'Delete space')?.click();
    flushSync();

    const asked = box.querySelector('[data-component="DeleteSpace"]') as HTMLElement;
    expect(asked.textContent).toContain('Общее');
  });

  it('участнику без управления удаление не предлагается', () => {
    const box = render({ space: { ...space, role: 'writer' } });
    expect(button(box, 'Delete space')).toBeUndefined();
  });
});
