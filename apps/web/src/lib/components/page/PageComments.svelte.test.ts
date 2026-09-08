/**
 * Обсуждение страницы.
 *
 * Проверяется одно: поле показывается тому, кто вправе писать. Сервер отказывает
 * читателю, если пространство ему этого не разрешало, и поле, отвечающее отказом
 * после набранного текста, хуже отсутствующего.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const deleteComment = vi.fn(() => Promise.resolve({}));
vi.mock('$lib/features/page/services/comments', () => ({
  createComment: () => Promise.resolve({}),
  deleteComment: (...args: unknown[]) => deleteComment(...(args as [])),
  resolveComment: () => Promise.resolve({}),
  updateComment: () => Promise.resolve({})
}));

vi.mock('$lib/features/realtime/socket', () => ({ onRealtime: () => () => {} }));

const copyText = vi.fn();
vi.mock('$lib/features/clipboard', () => ({ copyText: (...args: unknown[]) => copyText(...args) }));

// Поле ввода тянет за собой редактор целиком; проверке важно, есть оно или нет.
vi.mock('$lib/features/editor/CommentEditor.svelte', async () => ({
  default: (await import('../../../test-stubs/ReadyProbe.svelte')).default
}));

const { default: PageComments } = await import('./PageComments.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(PageComments, {
    target: host,
    props: { pageId: 'p1', comments: [], userId: 'u1', ...props } as never
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

/** Реплика в объёме, который читает разметка. */
function reply(id: string, text: string) {
  return {
    id,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    creatorId: 'u2',
    creatorName: 'Сосед',
    creatorAvatarUrl: null,
    parentCommentId: null,
    selection: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00Z'
  };
}

function hasComposer(box: HTMLElement): boolean {
  return box.querySelector('[data-component="ReadyProbe"]') !== null;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('PageComments', () => {
  it('показывает поле тому, кто вправе писать', () => {
    expect(hasComposer(render({ canComment: true }))).toBe(true);
  });

  it('прячет поле у того, кому сервер откажет', () => {
    expect(hasComposer(render({ canComment: false }))).toBe(false);
  });

  it('без указания права поле есть', () => {
    // Умолчание сохраняет прежнее поведение там, где право ещё не передаётся.
    expect(hasComposer(render({}))).toBe(true);
  });

  it('даёт ссылку на отдельную реплику', async () => {
    // Через свой маршрут: копирующий знает идентификатор реплики, но не
    // короткое имя страницы, а маршрут узнаёт страницу сам.
    copyText.mockResolvedValue(true);
    const box = render({ comments: [reply('c1', 'Первая')] });

    const link = [...box.querySelectorAll('button')].find(
      (one) => (one.textContent ?? '').trim() === 'Copy link'
    );
    link?.click();
    await Promise.resolve();

    expect(copyText).toHaveBeenCalledWith(`${window.location.origin}/c/c1`);
  });

  it('удаление реплики спрашивает', () => {
    // Кнопка стоит в ряду с безобидными «Решено» и «Ссылка», а реплика уходит
    // без возврата: без вопроса промах стирал бы чужие слова.
    deleteComment.mockClear();
    const box = render({ comments: [reply('c1', 'Первая')] });

    const remove = () =>
      [...box.querySelectorAll('button')].find(
        (one) => (one.textContent ?? '').trim() === 'Delete'
      ) as HTMLElement;

    remove().click();
    flushSync();
    expect(deleteComment).not.toHaveBeenCalled();
    expect(box.textContent).toContain('Are you sure you want to delete this comment?');

    remove().click();
    expect(deleteComment).toHaveBeenCalledWith('c1');
  });

  it('отказ от удаления реплику оставляет', () => {
    deleteComment.mockClear();
    const box = render({ comments: [reply('c1', 'Первая')] });

    (
      [...box.querySelectorAll('button')].find(
        (one) => (one.textContent ?? '').trim() === 'Delete'
      ) as HTMLElement
    ).click();
    flushSync();

    (
      [...box.querySelectorAll('button')].find(
        (one) => (one.textContent ?? '').trim() === 'Cancel'
      ) as HTMLElement
    ).click();
    flushSync();

    expect(deleteComment).not.toHaveBeenCalled();
    expect(box.textContent).not.toContain('Are you sure you want to delete this comment?');
  });

  it('подсвечивает реплику, названную ссылкой', () => {
    const box = render({
      comments: [reply('c1', 'Первая'), reply('c2', 'Вторая')],
      highlight: 'c2'
    });

    const marked = [...box.querySelectorAll('[data-comment]')].map((one) =>
      one.className.includes('border-accent')
    );
    expect(marked).toEqual([false, true]);
  });

  it('сами реплики видны и без права писать', () => {
    // Читать обсуждение вправе всякий, кто видит страницу: запрет касается
    // только того, чтобы в него писать.
    const box = render({
      canComment: false,
      comments: [
        {
          id: 'c1',
          pageId: 'p1',
          content: { type: 'doc', content: [] },
          creatorId: 'u2',
          createdAt: '2026-01-01T10:00:00Z',
          resolvedAt: null,
          parentCommentId: null,
          creatorName: 'Сосед',
          creatorAvatarUrl: null
        }
      ]
    });
    expect((box.textContent ?? '').includes('Сосед')).toBe(true);
  });
});
