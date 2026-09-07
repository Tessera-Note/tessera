/**
 * Экран базы.
 *
 * Проверяется необратимое: удаление базы предлагается только тому, кто вправе
 * её править, спрашивает до того, как сработать, и уводит с экрана — страница
 * базы к этому времени в корзине, и оставленный адрес отдал бы отказ.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls } from '../../../../test-stubs/app-navigation';

const deleteBase = vi.fn();
vi.mock('$lib/features/base/services/bases', async () => {
  const real = await vi.importActual<Record<string, unknown>>('$lib/features/base/services/bases');
  return {
    ...real,
    deleteBase: (...args: unknown[]) => deleteBase(...args),
    baseRows: () => Promise.resolve({ items: [], nextCursor: null, references: { users: [] } }),
    expandPages: () => Promise.resolve([])
  };
});

vi.mock('$lib/features/realtime/socket', () => ({
  sendRealtime: () => Promise.resolve(),
  onRealtime: () => () => {}
}));

const { default: BasePage } = await import('./+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

const base = {
  id: 'b1',
  slugId: 'b1',
  name: 'Проекты',
  icon: null,
  spaceId: 's1',
  baseSchemaVersion: 1,
  properties: [
    {
      id: 'p1',
      name: 'Название',
      type: 'title',
      position: 'a',
      typeOptions: null,
      isPrimary: true
    }
  ],
  views: [{ id: 'v1', name: 'Таблица', type: 'table', position: 'a', config: {} }],
  permissions: { canEdit: true, canView: true }
};

function render(over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(BasePage, {
    target: host,
    props: {
      data: {
        base,
        rows: { items: [], nextCursor: null, references: { users: [] } },
        members: [],
        space: { id: 's1', name: 'Общее', slug: 'general' },
        ...over
      } as never
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function button(box: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  deleteBase.mockReset();
  deleteBase.mockResolvedValue({ status: 'ok' });
  calls.goto.length = 0;
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('экран базы', () => {
  it('удаляет только после подтверждения и уводит в пространство', async () => {
    const box = render();

    button(box, 'Delete base')?.click();
    flushSync();
    expect(deleteBase).not.toHaveBeenCalled();

    button(box, 'Confirm')?.click();
    await settle();

    expect(deleteBase).toHaveBeenCalledWith('b1');
    expect(calls.goto).toContain('/s/general');
  });

  it('читателю удаление не предлагается', () => {
    const box = render({
      base: { ...base, permissions: { canEdit: false, canView: true } }
    });

    expect(button(box, 'Delete base')).toBeUndefined();
  });

  it('без известного пространства уводит на главную', async () => {
    const box = render({ space: null });

    button(box, 'Delete base')?.click();
    flushSync();
    button(box, 'Confirm')?.click();
    await settle();

    expect(calls.goto).toContain('/home');
  });
});
