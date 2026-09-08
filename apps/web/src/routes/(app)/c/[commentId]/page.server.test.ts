/**
 * Ссылка на отдельную реплику.
 *
 * Своего экрана у комментария нет: реплику читают вместе со страницей, которую
 * она обсуждает. Проверяется, что маршрут находит эту страницу по одному лишь
 * идентификатору реплики и уводит на неё с открытым обсуждением.
 */

import { describe, expect, it, vi } from 'vitest';

// Слой обращений к серверу подменяется целиком: настоящий доходит до
// `$app/environment`, которого вне сборки SvelteKit нет.
vi.mock('$lib/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 500;
    code: string | null = null;
  }
}));

const commentInfo = vi.fn();
const pageInfo = vi.fn();
vi.mock('$lib/features/page/services/comments', () => ({
  commentInfo: (...args: unknown[]) => commentInfo(...args)
}));
vi.mock('$lib/features/page/services/pages', () => ({
  pageInfo: (...args: unknown[]) => pageInfo(...args)
}));

const { load } = await import('./+page.server');

const spaces = [{ id: 's1', name: 'Общее', slug: 'general' }];

function run(commentId = 'c1') {
  return (load as (event: unknown) => Promise<unknown>)({
    params: { commentId },
    fetch,
    request: new Request('http://localhost/c/c1'),
    parent: () => Promise.resolve({ spaces })
  });
}

/** Переход в SvelteKit это исключение: поймать его — единственный способ его увидеть. */
function thrown(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (error) => error as { status: number; location?: string }
  );
}

describe('ссылка на реплику', () => {
  it('уводит на страницу реплики с открытым обсуждением', async () => {
    commentInfo.mockResolvedValue({ id: 'c1', pageId: 'pg1' });
    pageInfo.mockResolvedValue({ id: 'pg1', slugId: 'abc', spaceId: 's1' });

    const jump = await thrown(run());

    expect(jump?.status).toBe(307);
    expect(jump?.location).toBe('/s/general/p/abc?comment=c1');
  });

  it('реплика без страницы это не найдено', async () => {
    // Такого не бывает у живой реплики, но ответ сервера здесь — данные, а не
    // обещание: разыменование пустого поля дало бы пятисотый ответ.
    commentInfo.mockResolvedValue({ id: 'c1', pageId: null });

    expect((await thrown(run()))?.status).toBe(404);
  });

  it('страница из недоступного пространства это не найдено', async () => {
    commentInfo.mockResolvedValue({ id: 'c1', pageId: 'pg1' });
    pageInfo.mockResolvedValue({ id: 'pg1', slugId: 'abc', spaceId: 'другое' });

    expect((await thrown(run()))?.status).toBe(404);
  });
});
