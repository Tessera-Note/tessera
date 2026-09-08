/**
 * Однократный запрос страницы на показ.
 *
 * Проверяется то, ради чего модуль заведён: одна и та же страница, упомянутая
 * несколько раз, спрашивается один раз, и отказ по закрытой странице тоже
 * помнится — иначе каждое её упоминание спрашивало бы заново.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const pageInfo = vi.fn();
vi.mock('./pages', () => ({ pageInfo: (...args: unknown[]) => pageInfo(...args) }));

/**
 * Свежий модуль на каждую проверку: учёт спрошенного живёт в самом модуле, и
 * сброса наружу у него нет — в приложении его звать некому.
 */
type Cache = typeof import('./page-cache');
let cache: Cache;

beforeEach(async () => {
  pageInfo.mockReset();
  vi.resetModules();
  cache = await import('./page-cache');
});

describe('pageOnce', () => {
  it('спрашивает страницу один раз на несколько упоминаний', async () => {
    pageInfo.mockResolvedValue({ id: 'p1', title: 'Заголовок' });

    const [first, second] = await Promise.all([cache.pageOnce('slug'), cache.pageOnce('slug')]);

    expect(pageInfo).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('разные страницы спрашиваются каждая своим запросом', async () => {
    pageInfo.mockResolvedValue({ id: 'p1' });

    await Promise.all([cache.pageOnce('one'), cache.pageOnce('two')]);

    expect(pageInfo).toHaveBeenCalledTimes(2);
  });

  it('отказ отдаётся всем ждущим и не спрашивается заново', async () => {
    pageInfo.mockRejectedValue(new Error('нет доступа'));

    await expect(cache.pageOnce('slug')).rejects.toThrow('нет доступа');
    await expect(cache.pageOnce('slug')).rejects.toThrow('нет доступа');

    expect(pageInfo).toHaveBeenCalledTimes(1);
  });

  it('по истечении срока годности спрашивает заново', async () => {
    // Заголовок меняется редко, но не никогда: вечный учёт показывал бы
    // переименованную страницу прежним именем до перезагрузки вкладки.
    pageInfo.mockResolvedValue({ id: 'p1' });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await cache.pageOnce('slug');
      await cache.pageOnce('slug');
      expect(pageInfo).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
      await cache.pageOnce('slug');
      expect(pageInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
