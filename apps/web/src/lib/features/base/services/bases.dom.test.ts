/**
 * Групповое удаление строк базы.
 *
 * Проверяется дробление просьбы. Сервер берёт из перечня первые пятьсот
 * идентификаторов, а остальные отбрасывает молча: без дробления выбор из
 * тысячи строк убирал бы половину, а человеку сообщалось бы про тысячу.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('$lib/api/client', () => ({ post: (...args: unknown[]) => post(...args) }));

const { deleteRows } = await import('./bases');

/** Столько идентификаторов, сколько просили. */
function ids(count: number): string[] {
  return Array.from({ length: count }, (_, at) => `r${at}`);
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ deleted: 0 });
});

describe('deleteRows', () => {
  it('перечень до предела уходит одной просьбой', async () => {
    post.mockResolvedValue({ deleted: 3 });

    await expect(deleteRows('b1', ['r1', 'r2', 'r3'])).resolves.toBe(3);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/api/bases/rows/delete-many');
    expect(post.mock.calls[0][1]).toEqual({ baseId: 'b1', rowIds: ['r1', 'r2', 'r3'] });
  });

  it('перечень длиннее предела делится, и ничего не теряется', async () => {
    post.mockResolvedValue({ deleted: 500 });

    const removed = await deleteRows('b1', ids(1200));

    expect(post).toHaveBeenCalledTimes(3);
    const sizes = post.mock.calls.map((one) => (one[1] as { rowIds: string[] }).rowIds.length);
    expect(sizes).toEqual([500, 500, 200]);

    const sent = post.mock.calls.flatMap((one) => (one[1] as { rowIds: string[] }).rowIds);
    expect(sent).toEqual(ids(1200));
    // Считается отвеченное сервером, а не отправленное: удалить он мог меньше,
    // если строку уже убрал сосед.
    expect(removed).toBe(1500);
  });

  it('пустой перечень сервер не беспокоит', async () => {
    await expect(deleteRows('b1', [])).resolves.toBe(0);
    expect(post).not.toHaveBeenCalled();
  });
});
