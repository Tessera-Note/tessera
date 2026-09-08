/**
 * Экран групп.
 *
 * Проверяется продолжение перечня: перечень отдаётся страницами, и без кнопки
 * он обрывался бы на потолке выдачи молча — а по группам выдают доступ, и
 * невидимая группа выглядит как несуществующая.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listGroups = vi.fn();
vi.mock('$lib/features/group/services/groups', () => ({
  listGroups: (...args: unknown[]) => listGroups(...args),
  createGroup: () => Promise.resolve({}),
  deleteGroup: () => Promise.resolve({ success: true })
}));

const { default: GroupsPage } = await import('./+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function group(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    isDefault: false,
    directorySource: null,
    memberCount: 1
  };
}

function render(over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(GroupsPage, {
    target: host,
    props: {
      data: {
        groups: [group('g1', 'Первая')],
        nextCursor: 'к1',
        session: { user: { role: 'admin' } },
        ...over
      } as never
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function names(box: HTMLElement): string[] {
  return [...box.querySelectorAll('tbody tr td:first-child')].map((one) =>
    (one.textContent ?? '').trim()
  );
}

function button(box: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  listGroups.mockReset();
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('экран групп', () => {
  it('догружает следующую страницу', async () => {
    listGroups.mockResolvedValue({ items: [group('g2', 'Вторая')], meta: { nextCursor: null } });
    const box = render();

    button(box, 'Load more')?.click();
    await settle();

    expect(listGroups).toHaveBeenCalledWith({ cursor: 'к1' });
    expect(names(box)).toEqual(['Первая', 'Вторая']);
    expect(button(box, 'Load more')).toBeUndefined();
  });

  it('без курсора продолжения не предлагает', () => {
    const box = render({ nextCursor: null });
    expect(button(box, 'Load more')).toBeUndefined();
  });

  it('отказ догрузки виден и перечень не теряется', async () => {
    listGroups.mockRejectedValue(new Error('сеть'));
    const box = render();

    button(box, 'Load more')?.click();
    await settle();

    expect(names(box)).toEqual(['Первая']);
    expect(box.querySelector('[role="alert"], [data-component="Notice"]')).not.toBeNull();
  });
});
