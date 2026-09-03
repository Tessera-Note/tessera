import { describe, expect, it } from 'vitest';
import { OrderKeyError, fillKeys, keyBetween } from './order-key';
import { REFERENCE_KEYS } from './order-key.reference';

describe('keyBetween', () => {
  it('первый ключ списка', () => {
    expect(keyBetween(null, null)).toBe('a0');
  });

  it('совпадает с эталонными значениями fractional-indexing', () => {
    // Совпадение обязательно: ключи лежат в общей базе, и вторая версия обязана
    // продолжать ряд, начатый первой. Набор снят с самой библиотеки, которой
    // пользуется v1, — см. `order-key.reference.ts`.
    for (const [before, after, expected] of REFERENCE_KEYS) {
      expect(keyBetween(before, after), `${before} .. ${after}`).toBe(expected);
    }
  });

  it('эталонный набор что-то проверяет', () => {
    // Опора предыдущей проверки: пустой набор дал бы зелёный результат на
    // пустоте, то есть подтверждал бы совпадение, потому что нечему совпадать.
    expect(REFERENCE_KEYS.length).toBeGreaterThan(100);
    expect(REFERENCE_KEYS.some(([before]) => before !== null)).toBe(true);
    expect(REFERENCE_KEYS.some(([, after]) => after !== null)).toBe(true);
  });

  it('идёт вправо за границу целой части', () => {
    expect(keyBetween('az', null)).toBe('b00');
    expect(keyBetween('b00', null)).toBe('b01');
  });

  it('идёт влево за границу целой части', () => {
    expect(keyBetween(null, 'Z0')).toBe('Yzz');
  });

  it('отвергает перевёрнутый отрезок', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow(OrderKeyError);
    expect(() => keyBetween('a0', 'a0')).toThrow(OrderKeyError);
  });

  it('отвергает негодный ключ', () => {
    expect(() => keyBetween('', null)).toThrow(OrderKeyError);
    expect(() => keyBetween('a00', null)).toThrow(OrderKeyError);
    expect(() => keyBetween('!!', null)).toThrow(OrderKeyError);
    expect(() => keyBetween(null, `A${'0'.repeat(26)}`)).toThrow(OrderKeyError);
  });

  it('держит порядок при тысяче случайных вставок', () => {
    // Опора всего разбора: ключи сравниваются как строки, и любая вставка
    // обязана попасть ровно туда, куда её положили. Проверка перебором, потому
    // что дефект здесь виден не на одном значении, а на их последовательности.
    let seed = 20260902;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const keys: string[] = [keyBetween(null, null)];
    for (let step = 0; step < 1000; step += 1) {
      const at = Math.floor(random() * (keys.length + 1));
      const before = at === 0 ? null : keys[at - 1];
      const after = at === keys.length ? null : keys[at];
      const made = keyBetween(before, after);
      keys.splice(at, 0, made);
    }

    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('fillKeys', () => {
  it('раздаёт ключи списку без них', () => {
    const added = fillKeys([null, null, null]);
    expect(added.map((one) => one.index)).toEqual([0, 1, 2]);
    const keys = added.map((one) => one.key);
    expect([...keys].sort()).toEqual(keys);
  });

  it('не трогает уже заведённые', () => {
    const added = fillKeys(['a0', null, 'a2']);
    expect(added).toHaveLength(1);
    expect(added[0].index).toBe(1);
    expect(added[0].key > 'a0').toBe(true);
    expect(added[0].key < 'a2').toBe(true);
  });

  it('ставит ключи перед заведённым соседом', () => {
    const added = fillKeys([null, null, 'a5']);
    expect(added.map((one) => one.index)).toEqual([0, 1]);
    expect(added[0].key < added[1].key).toBe(true);
    expect(added[1].key < 'a5').toBe(true);
  });

  it('на полном списке ничего не возвращает', () => {
    expect(fillKeys(['a0', 'a1'])).toEqual([]);
  });
});
