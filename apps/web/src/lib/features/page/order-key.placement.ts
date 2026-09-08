/**
 * Куда встаёт перетащенная страница.
 *
 * Отдельно от самого разбора ключей: тот считает ключ между двумя соседями и
 * ничего не знает о дереве, а здесь решается, кто эти соседи.
 */

import { fillKeys, keyBetween } from './order-key';

/** Сосед в списке: только то, что нужно расстановке. */
export type Sibling = { id: string; position?: string | null };

export type Placement = {
  /** Ключи, которые надо проставить соседям до самой перестановки. */
  prepare: { id: string; position: string }[];
  /** Ключ переставляемой страницы. */
  position: string;
};

/**
 * Ключ для страницы, которую кладут в список `siblings` на место `index`.
 *
 * Сама переставляемая страница в списке не участвует: соседями считаются те,
 * между кем она встанет. Если у соседей ключей ещё нет — страницу заводили
 * обычным путём, и порядок ей задавало время создания, — ключи сперва
 * раздаются всему списку: положение «между двумя без ключа» выразить нечем.
 */
export function placeBetween(siblings: readonly Sibling[], index: number): Placement {
  const needs = fillKeys(siblings.map((one) => one.position));
  const prepare = needs.map((one) => ({ id: siblings[one.index].id, position: one.key }));

  const keys = siblings.map((one) => one.position ?? null);
  for (const one of needs) keys[one.index] = one.key;

  const at = Math.max(0, Math.min(index, keys.length));
  return {
    prepare,
    position: keyBetween(at === 0 ? null : keys[at - 1], at === keys.length ? null : keys[at])
  };
}
