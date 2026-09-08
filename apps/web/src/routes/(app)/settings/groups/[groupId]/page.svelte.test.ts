/**
 * Экран группы.
 *
 * Проверяется продолжение состава и то, что догруженные люди участвуют в
 * отборе кандидатов: иначе уже состоящий в группе предлагался бы к добавлению
 * второй раз, а добавление ничего бы не меняло.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const groupMembers = vi.fn();
vi.mock('$lib/features/group/services/groups', () => ({
  groupMembers: (...args: unknown[]) => groupMembers(...args),
  addGroupMembers: () => Promise.resolve({ added: 1 }),
  attachDirectory: () => Promise.resolve({}),
  deleteGroup: () => Promise.resolve({ success: true }),
  detachDirectory: () => Promise.resolve({}),
  removeGroupMember: () => Promise.resolve({ success: true }),
  updateGroup: () => Promise.resolve({})
}));

const { default: GroupPage } = await import('./+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function member(id: string, name: string) {
  return { id, name, email: `${id}@example.com` };
}

const group = {
  id: 'g1',
  name: 'Первая',
  description: null,
  isDefault: false,
  directorySource: null,
  memberCount: 2
};

function render(over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(GroupPage, {
    target: host,
    props: {
      data: {
        group,
        members: [member('u1', 'Первый')],
        membersCursor: 'к1',
        people: [member('u1', 'Первый'), member('u2', 'Второй'), member('u3', 'Третий')],
        providers: [],
        ...over
      } as never
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function roster(box: HTMLElement): number {
  return box.querySelectorAll('[data-component="GroupMembers"] > li').length;
}

function candidates(box: HTMLElement): string[] {
  return [...box.querySelectorAll('select option')].map((one) => (one.textContent ?? '').trim());
}

function button(box: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  groupMembers.mockReset();
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('экран группы', () => {
  it('догружает следующую страницу состава', async () => {
    groupMembers.mockResolvedValue({ items: [member('u2', 'Второй')], meta: { nextCursor: null } });
    const box = render();

    button(box, 'Load more')?.click();
    await settle();

    expect(groupMembers).toHaveBeenCalledWith({ groupId: 'g1', cursor: 'к1' });
    expect(roster(box)).toBe(2);
    expect(button(box, 'Load more')).toBeUndefined();
  });

  it('догруженный человек уходит из предлагаемых к добавлению', async () => {
    groupMembers.mockResolvedValue({ items: [member('u2', 'Второй')], meta: { nextCursor: null } });
    const box = render();

    expect(candidates(box)).toContain('Второй');

    button(box, 'Load more')?.click();
    await settle();

    // Он уже в группе: предлагать его к добавлению значит предлагать действие,
    // которое ничего не изменит.
    expect(candidates(box)).not.toContain('Второй');
    expect(candidates(box)).toContain('Третий');
  });

  it('без курсора продолжения не предлагает', () => {
    const box = render({ membersCursor: null });
    expect(button(box, 'Load more')).toBeUndefined();
  });
});
