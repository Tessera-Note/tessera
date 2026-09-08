/**
 * Показ упоминания.
 *
 * Проверяется разница, ради которой упоминание разрешается на лету: имя
 * удалённого не остаётся в теле страницы, отключённый отличим от действующего,
 * удалённая страница отличима от живой, а отказ сети не превращает ни то, ни
 * другое в «удалён».
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mentionTarget = vi.fn();
const pageOnce = vi.fn();

vi.mock('$lib/features/user/services/mentions', () => ({
  mentionTarget: (...args: unknown[]) => mentionTarget(...args)
}));
vi.mock('$lib/features/page/services/page-cache', () => ({
  pageOnce: (...args: unknown[]) => pageOnce(...args)
}));

const { default: MentionView } = await import('./MentionView.svelte');
const { ApiError } = await import('$lib/api/failure');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(attributes: Record<string, unknown>): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(MentionView, {
    target: host,
    props: {
      node: {} as never,
      attributes,
      selected: false,
      editable: false,
      editor: {} as never,
      updateAttributes: () => {},
      position: () => 0
    }
  }) as Record<string, unknown>;
  flushSync();
}

/** Дать разрешению дойти до показа: ответ приходит обещанием. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

function shown(): HTMLElement {
  const found = host?.querySelector<HTMLElement>('[data-component="MentionChip"]');
  if (!found) throw new Error('упоминания нет');
  return found;
}

beforeEach(() => {
  mentionTarget.mockReset();
  pageOnce.mockReset();
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('MentionView, упоминание человека', () => {
  it('показывает нынешнее имя, а не замороженное', async () => {
    mentionTarget.mockResolvedValue({
      id: 'u1',
      name: 'Новое имя',
      deactivated: false
    });

    render({ entityType: 'user', entityId: 'u1', label: 'Прежнее имя' });
    await settle();

    expect(shown().textContent).toContain('Новое имя');
    expect(shown().textContent).not.toContain('Прежнее имя');
  });

  it('удалённого показывает обезличенно', async () => {
    // Ради этого разрешение и заведено: обезличивание при удалении до
    // содержимого страниц не доходит.
    mentionTarget.mockResolvedValue(null);

    render({ entityType: 'user', entityId: 'u1', label: 'Ушедший' });
    await settle();

    expect(shown().textContent).toContain('Deleted user');
    expect(shown().textContent).not.toContain('Ушедший');
    expect(shown().getAttribute('title')).toBe('This account no longer exists.');
  });

  it('отключённого отличает от действующего', async () => {
    mentionTarget.mockResolvedValue({
      id: 'u1',
      name: 'Отключённый',
      deactivated: true
    });

    render({ entityType: 'user', entityId: 'u1', label: 'Отключённый' });
    await settle();

    expect(shown().getAttribute('title')).toBe('This account is deactivated.');
    expect(shown().className).toContain('text-muted');
  });

  it('на отказе оставляет прежнюю подпись', async () => {
    // Сеть не должна превращать упоминание в «удалён».
    mentionTarget.mockRejectedValue(new Error('сеть'));

    render({ entityType: 'user', entityId: 'u1', label: 'Прежнее имя' });
    await settle();

    expect(shown().textContent).toContain('Прежнее имя');
    expect(shown().textContent).not.toContain('Deleted user');
  });

  it('человека не делает ссылкой', () => {
    mentionTarget.mockResolvedValue(null);
    render({ entityType: 'user', entityId: 'u1', label: 'Кто-то' });
    expect(shown().tagName).toBe('SPAN');
  });
});

describe('MentionView, упоминание страницы', () => {
  it('показывает нынешний заголовок и значок', async () => {
    pageOnce.mockResolvedValue({ id: 'p1', title: 'Новый заголовок', icon: '📘' });

    render({ entityType: 'page', slugId: 'abc', label: 'Прежний заголовок' });
    await settle();

    expect(shown().textContent).toContain('Новый заголовок');
    expect(shown().textContent).toContain('📘');
    expect(shown().getAttribute('href')).toBe('/p/abc');
  });

  it('удалённую показывает перечёркнутой и без ссылки', async () => {
    pageOnce.mockRejectedValue(new ApiError(404, 'error.page.page_not_found', '', {}));

    render({ entityType: 'page', slugId: 'abc', label: 'Пропавшая' });
    await settle();

    expect(shown().tagName).toBe('SPAN');
    expect(shown().className).toContain('line-through');
    expect(shown().getAttribute('title')).toBe(
      'This page no longer exists. It may have been deleted.'
    );
  });

  it('закрытую правами оставляет кликабельной, но помечает', async () => {
    // По ней можно попросить доступ: убирать ссылку значило бы отнимать это.
    pageOnce.mockRejectedValue(new ApiError(403, 'error.common.forbidden', '', {}));

    render({ entityType: 'page', slugId: 'abc', label: 'Закрытая' });
    await settle();

    expect(shown().tagName).toBe('A');
    expect(shown().getAttribute('title')).toBe("You don't have access to this page.");
    expect(shown().className).not.toContain('line-through');
  });

  it('потерянный вход не выдаёт за отсутствие доступа', async () => {
    // Публичный показ по ссылке идёт без сессии: там 401 приходит на каждое
    // упоминание, и пометка «нет доступа» была бы неправдой.
    pageOnce.mockRejectedValue(new ApiError(401, 'error.auth.unauthorized', '', {}));

    render({ entityType: 'page', slugId: 'abc', label: 'Прежний заголовок' });
    await settle();

    expect(shown().tagName).toBe('A');
    expect(shown().textContent).toContain('Прежний заголовок');
    expect(shown().getAttribute('title')).toBeNull();
  });

  it('якорь сохраняется в адресе', async () => {
    pageOnce.mockResolvedValue({ id: 'p1', title: 'Заголовок', icon: null });

    render({ entityType: 'page', slugId: 'abc', label: 'Заголовок', anchorId: 'h1' });
    await settle();

    expect(shown().getAttribute('href')).toBe('/p/abc#h1');
  });
});
