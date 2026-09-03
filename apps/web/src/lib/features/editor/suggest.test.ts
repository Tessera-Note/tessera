import { describe, expect, it } from 'vitest';
import {
  EMOJI,
  MENTION,
  SLASH,
  fuzzyMatch,
  moveSelection,
  readTrigger,
  type SuggestState
} from './suggest';

const RULES = [SLASH, MENTION, EMOJI];

/**
 * Состояние документа с одним абзацем.
 *
 * Настоящий `EditorState` сюда не тянется намеренно: разбор запроса читает
 * ровно четыре поля, и проверка на строках находит те же ошибки, не поднимая
 * ни схемы, ни редактора.
 */
function state(
  text: string,
  options: { code?: boolean; empty?: boolean; base?: number } = {}
): SuggestState {
  const base = options.base ?? 1;
  return {
    selection: {
      empty: options.empty ?? true,
      from: base + text.length,
      $from: {
        parentOffset: text.length,
        parent: {
          type: options.code ? { name: 'codeBlock', spec: { code: true } } : { name: 'paragraph' },
          textBetween: (from: number, to: number) => text.slice(from, to)
        }
      }
    }
  };
}

describe('readTrigger', () => {
  it('открывает перечень блоков на голой косой черте', () => {
    expect(readTrigger(state('/'), RULES)).toEqual({
      char: '/',
      query: '',
      from: 1,
      to: 2
    });
  });

  it('отдаёт набранное после знака', () => {
    expect(readTrigger(state('/tab'), RULES)?.query).toBe('tab');
  });

  it('молчит, когда знак прирос к слову', () => {
    expect(readTrigger(state('mail@example'), RULES)).toBeNull();
    expect(readTrigger(state('a/b'), RULES)).toBeNull();
  });

  it('открывается после пробела', () => {
    const found = readTrigger(state('текст @бо'), RULES);
    expect(found?.char).toBe('@');
    expect(found?.query).toBe('бо');
  });

  it('закрывается на пробеле после запроса', () => {
    expect(readTrigger(state('/tab le'), RULES)).toBeNull();
  });

  it('не открывает эмодзи на одиночном двоеточии', () => {
    expect(readTrigger(state(':'), RULES)).toBeNull();
    expect(readTrigger(state(':s'), RULES)).toBeNull();
    expect(readTrigger(state(':sm'), RULES)?.char).toBe(':');
  });

  it('берёт ближайший к каретке знак', () => {
    const found = readTrigger(state('/tab @bob :smi'), RULES);
    expect(found?.char).toBe(':');
    expect(found?.query).toBe('smi');
  });

  it('молчит внутри блока кода', () => {
    expect(readTrigger(state('/tab', { code: true }), RULES)).toBeNull();
  });

  it('молчит при выделении', () => {
    expect(readTrigger(state('/tab', { empty: false }), RULES)).toBeNull();
  });

  it('молчит на слишком длинном запросе', () => {
    expect(readTrigger(state(`/${'x'.repeat(41)}`), RULES)).toBeNull();
  });

  it('молчит, когда между знаком и кареткой встроенный узел', () => {
    expect(readTrigger(state('/та￼б'), RULES)).toBeNull();
  });

  it('считает отрезок от позиции каретки', () => {
    const found = readTrigger(state('раз /tab', { base: 12 }), RULES);
    // Каретка на 12 + 8, знак на четыре знака левее конца строки.
    expect(found).toEqual({ char: '/', query: 'tab', from: 16, to: 20 });
  });
});

describe('fuzzyMatch', () => {
  it('находит по знакам в том же порядке', () => {
    expect(fuzzyMatch('hr', 'Horizontal rule')).toBe(true);
    expect(fuzzyMatch('tbl', 'Table')).toBe(true);
    expect(fuzzyMatch('tabx', 'Table')).toBe(false);
  });

  it('пустой запрос подходит всему', () => {
    expect(fuzzyMatch('', 'Table')).toBe(true);
  });

  it('порядок знаков важен', () => {
    expect(fuzzyMatch('rh', 'Horizontal rule')).toBe(false);
  });
});

describe('moveSelection', () => {
  it('закольцовывает вниз и вверх', () => {
    expect(moveSelection(2, 3, 1)).toBe(0);
    expect(moveSelection(0, 3, -1)).toBe(2);
    expect(moveSelection(0, 3, 1)).toBe(1);
  });

  it('на пустом списке остаётся на нуле', () => {
    expect(moveSelection(0, 0, 1)).toBe(0);
  });
});
