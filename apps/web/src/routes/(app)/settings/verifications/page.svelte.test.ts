/**
 * Перечень проверяемых страниц.
 *
 * Проверяется постраничность: отбор по правам выбрасывает строки уже после
 * выборки, поэтому короткая страница — не конец перечня, и продолжение
 * предлагается по курсору, а не по числу показанных строк.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listVerifications = vi.fn();
vi.mock('$lib/features/verification/services/verifications', async () => {
  const real = await vi.importActual<Record<string, unknown>>(
    '$lib/features/verification/services/verifications'
  );
  return { ...real, listVerifications: (...args: unknown[]) => listVerifications(...args) };
});

const { default: VerificationsPage } = await import('./+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function row(id: string, title: string) {
  return {
    id,
    pageId: id,
    status: 'pending',
    mode: 'period',
    expiresAt: null,
    verifiedAt: null,
    createdAt: '',
    pageTitle: title,
    pageSlugId: id,
    pageIcon: null,
    spaceName: 'General',
    spaceSlug: 'general'
  };
}

function render(over: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(VerificationsPage, {
    target: host,
    props: {
      data: {
        rows: [row('v1', 'Первая')],
        nextCursor: null,
        members: [],
        status: undefined,
        spaceId: undefined,
        query: undefined,
        verifierId: undefined,
        spaces: [],
        session: { user: { id: 'u1', role: 'owner' }, workspace: {} },
        ...over
      } as never
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function buttons(box: HTMLElement): string[] {
  return [...box.querySelectorAll('button')].map((one) => (one.textContent ?? '').trim());
}

beforeEach(() => {
  listVerifications.mockReset();
  listVerifications.mockResolvedValue({
    items: [row('v2', 'Вторая')],
    meta: { nextCursor: null }
  });
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('экран проверок', () => {
  it('без курсора продолжения не предлагает', () => {
    const box = render();
    expect(buttons(box)).not.toContain('Load more');
  });

  it('догружает продолжение и сохраняет отбор', async () => {
    const box = render({ nextCursor: 'дальше', status: 'pending', spaceId: 's1' });

    const more = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Load more'
    );
    more?.click();
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    flushSync();

    // Отбор идёт вместе с курсором: без него продолжение приходило бы из
    // другого перечня.
    expect(listVerifications).toHaveBeenCalledWith({
      status: 'pending',
      spaceId: 's1',
      query: undefined,
      verifierId: undefined,
      cursor: 'дальше'
    });
    expect(box.textContent).toContain('Вторая');
    expect(box.textContent).toContain('Первая');
  });
});
