import { describe, expect, it } from 'vitest';
import { placeBetween } from './order-key.placement';
import { zoneAt } from './drop-zone';

describe('placeBetween', () => {
  it('кладёт между соседями с ключами', () => {
    const { prepare, position } = placeBetween(
      [
        { id: 'a', position: 'a0' },
        { id: 'b', position: 'a1' }
      ],
      1
    );
    expect(prepare).toEqual([]);
    expect(position > 'a0').toBe(true);
    expect(position < 'a1').toBe(true);
  });

  it('кладёт в начало и в конец', () => {
    const first = placeBetween([{ id: 'a', position: 'a1' }], 0);
    expect(first.position < 'a1').toBe(true);

    const last = placeBetween([{ id: 'a', position: 'a1' }], 1);
    expect(last.position > 'a1').toBe(true);
  });

  it('раздаёт ключи списку без них', () => {
    const { prepare, position } = placeBetween([{ id: 'a' }, { id: 'b' }], 1);
    expect(prepare.map((one) => one.id)).toEqual(['a', 'b']);
    expect(position > prepare[0].position).toBe(true);
    expect(position < prepare[1].position).toBe(true);
  });

  it('на пустом списке даёт первый ключ', () => {
    expect(placeBetween([], 0).position).toBe('a0');
  });

  it('выходящее за край место прижимается к краю', () => {
    const beyond = placeBetween([{ id: 'a', position: 'a0' }], 9);
    expect(beyond.position > 'a0').toBe(true);
  });
});

describe('zoneAt', () => {
  it('верх строки ставит до, низ — после, середина вкладывает', () => {
    expect(zoneAt(2, 30)).toBe('before');
    expect(zoneAt(15, 30)).toBe('inside');
    expect(zoneAt(28, 30)).toBe('after');
  });

  it('строка без высоты вкладывает', () => {
    expect(zoneAt(0, 0)).toBe('inside');
  });
});
