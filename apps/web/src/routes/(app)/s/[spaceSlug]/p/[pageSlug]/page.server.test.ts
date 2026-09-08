/**
 * Загрузка страницы.
 *
 * База это тоже страница, и ссылаются на неё отовсюду как на страницу. Здесь
 * проверяется, что база уходит на свой экран: показанная редактором, она
 * открылась бы пустой — содержимое базы лежит в строках, а не в документе.
 */

import { describe, expect, it, vi } from 'vitest';

// Слой обращений к серверу подменяется целиком: настоящий доходит до
// `$app/environment`, которого вне сборки SvelteKit нет. Загрузке из него
// нужен только разбор отказа.
vi.mock('$lib/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 500;
    code: string | null = null;
  }
}));

const pageInfo = vi.fn();
vi.mock('$lib/features/page/services/pages', () => ({
  pageInfo: (...args: unknown[]) => pageInfo(...args),
  breadcrumbs: () => Promise.resolve([]),
  watchStatus: () => Promise.resolve({ isWatching: false, isMuted: false })
}));
vi.mock('$lib/features/page/services/backlinks', () => ({
  backlinksCount: () => Promise.resolve({ count: 0 })
}));
vi.mock('$lib/features/page/services/comments', () => ({
  listComments: () => Promise.resolve([])
}));
vi.mock('$lib/features/page/services/favorites', () => ({
  listFavorites: () => Promise.resolve([])
}));
vi.mock('$lib/features/page/services/history', () => ({ listVersions: () => Promise.resolve([]) }));
vi.mock('$lib/features/page/services/labels', () => ({ labelsOfPage: () => Promise.resolve([]) }));
vi.mock('$lib/features/page/services/permissions', () => ({
  permissionInfo: () => Promise.resolve(null)
}));
vi.mock('$lib/features/verification/services/page', () => ({
  verificationInfo: () => Promise.resolve(null)
}));
vi.mock('$lib/features/share/services/share', () => ({
  shareForPage: () => Promise.resolve(null)
}));

const { load } = await import('./+page.server');

const spaces = [{ id: 's1', name: 'Общее', slug: 'general' }];

function run() {
  return (load as (event: unknown) => Promise<unknown>)({
    params: { spaceSlug: 'general', pageSlug: 'abc' },
    fetch,
    request: new Request('http://localhost/s/general/p/abc'),
    parent: () => Promise.resolve({ spaces })
  });
}

describe('загрузка страницы', () => {
  it('базу отправляет на её экран', async () => {
    pageInfo.mockResolvedValue({ id: 'b1', slugId: 'abc', spaceId: 's1', isBase: true });

    // Переход в SvelteKit это исключение, а не возврат: поймать его здесь —
    // единственный способ увидеть, куда именно он ведёт.
    const thrown = await run().then(
      () => null,
      (error) => error as { status: number; location: string }
    );

    expect(thrown?.status).toBe(307);
    expect(thrown?.location).toBe('/base/b1');
  });

  it('обычную страницу отдаёт как есть', async () => {
    pageInfo.mockResolvedValue({ id: 'pg1', slugId: 'abc', spaceId: 's1', isBase: false });

    const data = (await run()) as { page: { id: string } };

    expect(data.page.id).toBe('pg1');
  });
});
