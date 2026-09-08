import { describe, expect, it } from 'vitest';
import { findEmoji } from './emoji';
import type { EmojiRow } from './emoji-data';

const SET: readonly EmojiRow[] = [
  ['😄', 'smile', 'grinning face with smiling eyes happy joy'],
  ['😊', 'blush', 'smiling face with smiling eyes proud'],
  ['🚀', 'rocket', 'rocket launch ship space'],
  ['😀', 'grinning', 'grinning face smile happy']
];

describe('findEmoji', () => {
  it('находит по имени и по словам', () => {
    expect(findEmoji('rocket', SET).map((row) => row[1])).toEqual(['rocket']);
    expect(findEmoji('launch', SET).map((row) => row[1])).toEqual(['rocket']);
  });

  it('ставит совпадение в начале имени выше совпадения в словах', () => {
    expect(findEmoji('smi', SET).map((row) => row[1])).toEqual(['smile', 'blush', 'grinning']);
  });

  it('при равном совпадении выше идёт выбранное чаще', () => {
    const order = findEmoji('smiling', SET, { blush: 5 }).map((row) => row[1]);
    expect(order).toEqual(['blush', 'smile']);
  });

  it('на пустом запросе показывает только выбранное прежде', () => {
    expect(findEmoji('', SET, {}).length).toBe(0);
    expect(findEmoji('', SET, { rocket: 2, smile: 9 }).map((row) => row[1])).toEqual([
      'smile',
      'rocket'
    ]);
  });

  it('ничего не находит на бессмысленном запросе', () => {
    expect(findEmoji('щщщ', SET)).toEqual([]);
  });
});
