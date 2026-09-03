/**
 * Подбор по знаку-запятнателю: «/» для блоков, «@» для упоминаний, «:» для
 * эмодзи.
 *
 * Своё, а не `@tiptap/suggestion`. Причина не в возможностях того пакета, а в
 * его происхождении: он объявлен зависимостью первой версии и попадает сюда
 * только тем, что pnpm поднял его в общий `node_modules`. Опереться на это
 * значит опереться на расположение файлов, а не на объявленный состав — и
 * первая же установка с иным разрешением зависимостей ломает редактор. Свой
 * разбор занимает один файл и проверяется без редактора вовсе.
 *
 * Здесь только чтение состояния. Что показывать и куда, решает разметка:
 * так весь разбор остаётся чистой функцией, а её проверка — набором строк.
 */

import type { ComponentType } from 'svelte';

/** Одна строка перечня подбора. Значок или знак — что-то одно из двух. */
export type SuggestItem = {
  key: string;
  label: string;
  /** Пояснение справа: адрес почты у человека, имя у эмодзи. */
  hint?: string;
  icon?: ComponentType;
  glyph?: string;
};

/** Разрешённая позиция каретки, какой её отдаёт ProseMirror. */
type Resolved = {
  parent: {
    type: { name: string; spec?: { code?: boolean } };
    textBetween: (from: number, to: number, blockSeparator?: string, leafText?: string) => string;
  };
  parentOffset: number;
};

/** Состояние документа в объёме, нужном разбору. */
export type SuggestState = {
  selection: { empty: boolean; from: number; $from: Resolved };
};

/** Найденный запрос: знак, набранное после него и занятый им отрезок. */
export type Trigger = {
  char: string;
  query: string;
  /** Начало отрезка вместе со знаком: его заменяет вставка. */
  from: number;
  to: number;
};

/** Условия одного знака. */
export type TriggerRule = {
  char: string;
  /**
   * Сколько знаков надо набрать после запятнателя, чтобы список открылся.
   *
   * Ноль у «/» и «@»: они в обычном тексте почти не встречаются, и список
   * уместно показать сразу. Двоеточие встречается постоянно, поэтому у «:»
   * порог выше — иначе список открывался бы на каждом перечислении.
   */
  minQuery: number;
  /** Предел длины запроса. Длиннее — человек пишет текст, а не ищет. */
  maxQuery?: number;
};

export const SLASH: TriggerRule = { char: '/', minQuery: 0 };
export const MENTION: TriggerRule = { char: '@', minQuery: 0 };
export const EMOJI: TriggerRule = { char: ':', minQuery: 2 };

/** Знак-заполнитель встроенного узла. Один знак на узел — длины совпадают с позициями. */
const LEAF = '￼';

const DEFAULT_MAX_QUERY = 40;

/**
 * Найти начатый запрос перед кареткой.
 *
 * Правил три, и все три нужны. Выделение должно быть пустым — при выделенном
 * куске человек не набирает запрос. Знак должен стоять в начале строки или
 * после пробела — иначе `mail@example.com` открывал бы перечень людей на
 * каждом адресе. И между знаком и кареткой не должно быть пробела: пробел
 * означает, что запрос кончился, а знак остался частью текста.
 */
export function readTrigger(state: SuggestState, rules: readonly TriggerRule[]): Trigger | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const $from = selection.$from;
  // Внутри блока кода подбор не работает: там «/» и «:» это код, а не запрос.
  if ($from.parent.type.spec?.code || $from.parent.type.name === 'codeBlock') return null;

  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, LEAF);

  let best: Trigger | null = null;
  // Смещение выбранного знака внутри блока. Сравнивать по `Trigger.from`
  // нельзя: там позиция в документе, а здесь смещение в строке.
  let bestAt = -1;

  for (const rule of rules) {
    const at = before.lastIndexOf(rule.char);
    if (at < 0) continue;

    const preceding = at === 0 ? '' : before[at - 1];
    if (preceding && !/\s/.test(preceding)) continue;

    const query = before.slice(at + rule.char.length);
    if (query.length < rule.minQuery) continue;
    if (query.length > (rule.maxQuery ?? DEFAULT_MAX_QUERY)) continue;
    if (/\s/.test(query)) continue;
    if (query.includes(LEAF)) continue;

    // Ближайший к каретке выигрывает: набрав «@имя:тек», человек пишет уже
    // эмодзи, а не имя, и перечень людей ему больше не нужен.
    if (at <= bestAt) continue;
    bestAt = at;
    best = {
      char: rule.char,
      query,
      from: selection.from - (before.length - at),
      to: selection.from
    };
  }

  return best;
}

/**
 * Нечёткое совпадение: знаки запроса встречаются в цели в том же порядке.
 *
 * Тот же разбор, что и в v1: «hr» находит «Horizontal rule». Пустой запрос
 * подходит всему — при нём список показывается целиком.
 */
export function fuzzyMatch(query: string, target: string): boolean {
  const lower = target.toLowerCase();
  let at = 0;
  for (const char of lower) {
    if (query[at] === char) at += 1;
    if (at === query.length) return true;
  }
  return at === query.length;
}

/** Двигать выбор по списку с закольцовыванием: снизу — снова наверх. */
export function moveSelection(current: number, total: number, step: number): number {
  if (total <= 0) return 0;
  return (current + step + total) % total;
}
