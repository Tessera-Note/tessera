/**
 * Разрешение упоминаний.
 *
 * Проверяется то, ради чего у этого модуля есть собственный учёт: пачка вместо
 * запроса на каждое упоминание, ответ «такого нет» отдельно от отказа сети и
 * повтор без второго обращения.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('$lib/api/client', () => ({ post: (...args: unknown[]) => post(...args) }));

/**
 * Свежий модуль на каждую проверку.
 *
 * Учёт спрошенного живёт в самом модуле, и одна проверка иначе отвечала бы за
 * другую. Сброса наружу у модуля нет намеренно: в приложении его звать некому,
 * а ради проверок держать в production-коде вызов без вызывающего нельзя.
 */
type Mentions = typeof import('./mentions');
let mentions: Mentions;

/** Один человек в ответе сервера. */
function person(id: string, values: Record<string, unknown> = {}) {
  return { id, name: 'Имя', deactivated: false, ...values };
}

beforeEach(async () => {
  post.mockReset();
  vi.resetModules();
  mentions = await import('./mentions');
});

describe('resolveMentions', () => {
  it('шлёт перечень тем же полем, что ждёт сервер', async () => {
    post.mockResolvedValue([]);
    await mentions.resolveMentions(['a', 'b']);
    expect(post).toHaveBeenCalledWith(
      '/api/users/mentions',
      { userIds: ['a', 'b'] },
      {
        fetcher: undefined
      }
    );
  });
});

describe('mentionTarget', () => {
  it('собирает несколько упоминаний в один запрос', async () => {
    post.mockResolvedValue([person('a'), person('b')]);

    const [first, second] = await Promise.all([
      mentions.mentionTarget('a'),
      mentions.mentionTarget('b')
    ]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toEqual({ userIds: ['a', 'b'] });
    expect(first?.id).toBe('a');
    expect(second?.id).toBe('b');
  });

  it('одного и того же человека спрашивает один раз', async () => {
    post.mockResolvedValue([person('a')]);

    const [first, second] = await Promise.all([
      mentions.mentionTarget('a'),
      mentions.mentionTarget('a')
    ]);

    expect(post.mock.calls[0][1]).toEqual({ userIds: ['a'] });
    expect(first).toBe(second);
  });

  it('отсутствие в ответе это ответ, а не отказ', async () => {
    // По нему показ ставит обезличенную подпись: человек удалён.
    post.mockResolvedValue([]);
    await expect(mentions.mentionTarget('a')).resolves.toBeNull();
  });

  it('повтор берётся из учёта, без второго обращения', async () => {
    post.mockResolvedValue([person('a')]);

    await mentions.mentionTarget('a');
    await mentions.mentionTarget('a');

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('по истечении срока годности спрашивает заново', async () => {
    // Имя меняется редко, но не никогда: вечный учёт показывал бы
    // переименованного прежним именем до перезагрузки вкладки.
    post.mockResolvedValue([person('a')]);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await mentions.mentionTarget('a');
      await mentions.mentionTarget('a');
      expect(post).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
      await mentions.mentionTarget('a');
      expect(post).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('отсутствие человека тоже запоминается', async () => {
    // Иначе показ спрашивал бы про удалённого при каждой отрисовке.
    post.mockResolvedValue([]);

    await mentions.mentionTarget('a');
    await mentions.mentionTarget('a');

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('отказ проходит наружу и не запоминается', async () => {
    // Сеть не должна превращать упоминание в «удалён» до конца сеанса.
    post.mockRejectedValueOnce(new Error('сеть'));
    await expect(mentions.mentionTarget('a')).rejects.toThrow('сеть');

    post.mockResolvedValueOnce([person('a')]);
    await expect(mentions.mentionTarget('a')).resolves.not.toBeNull();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('отказ достаётся всем, кто ждал в той же пачке', async () => {
    post.mockRejectedValue(new Error('сеть'));

    const waiting = [mentions.mentionTarget('a'), mentions.mentionTarget('b')];

    await expect(Promise.allSettled(waiting)).resolves.toEqual([
      { status: 'rejected', reason: expect.any(Error) },
      { status: 'rejected', reason: expect.any(Error) }
    ]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('пачка длиннее предела уходит в два запроса', async () => {
    // Предел тот же, что стоит на сервере: запрос сверх него он отвергает.
    post.mockResolvedValue([]);

    const many = Array.from({ length: 201 }, (_, index) => `u${index}`);
    await Promise.all(many.map((id) => mentions.mentionTarget(id)));

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].userIds).toHaveLength(200);
    expect(post.mock.calls[1][1].userIds).toEqual(['u200']);
  });
});
