/**
 * Слияние соседних списков.
 *
 * ProseMirror не сливает два списка одного вида, оказавшихся рядом: вставка
 * между ними, удаление разделявшего абзаца или отмена правки оставляют два
 * списка вплотную, и нумерация во втором начинается заново. Человек видит
 * «1, 2, 3, 1, 2» и считает это поломкой нумерации.
 *
 * Перенесено из v1 (`extensions/autojoiner.ts`, MIT,
 * https://github.com/NiclasDev63/tiptap-extension-auto-joiner) с одной
 * правкой: `getNodeType` берётся из `@tiptap/core`, а не из обвязки React,
 * которой здесь нет.
 */

import { Extension, getNodeType } from '@tiptap/core';
import type { NodeType } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';

/**
 * Слить всё, что можно слить, в пределах изменённого.
 *
 * Взято из `wrapDispatchForJoin` в `prosemirror-commands`: изменённые отрезки
 * собираются по всем правкам и переносятся вперёд через отображения поздних —
 * иначе позиции указывают в прежний документ, а сливать надо в новом.
 */
function autoJoin(
  transactions: readonly Transaction[],
  next: Transaction,
  kinds: NodeType[]
): boolean {
  const ranges: number[] = [];
  for (const one of transactions) {
    for (const map of one.mapping.maps) {
      for (let i = 0; i < ranges.length; i += 1) ranges[i] = map.map(ranges[i]);
      map.forEach((_start, _end, from, to) => ranges.push(from, to));
    }
  }

  // Где границы узлов одного вида стоят вплотную.
  const points: number[] = [];
  for (let i = 0; i < ranges.length; i += 2) {
    const from = ranges[i];
    const to = ranges[i + 1];
    const at = next.doc.resolve(from);
    const depth = at.sharedDepth(to);
    const parent = at.node(depth);

    let index = at.indexAfter(depth);
    let pos = at.after(depth + 1);
    while (pos <= to) {
      const after = parent.maybeChild(index);
      if (!after) break;
      if (index && !points.includes(pos)) {
        const before = parent.child(index - 1);
        if (before.type === after.type && kinds.includes(before.type)) points.push(pos);
      }
      pos += after.nodeSize;
      index += 1;
    }
  }

  // С конца: слияние сдвигает всё, что стоит после него.
  let joined = false;
  points.sort((a, b) => a - b);
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (canJoin(next.doc, points[i])) {
      next.join(points[i]);
      joined = true;
    }
  }
  return joined;
}

export type AutoJoinerOptions = {
  /** Что сливать сверх списков. Имена узлов схемы. */
  elementsToJoin: string[];
};

export const AutoJoiner = Extension.create<AutoJoinerOptions>({
  name: 'autoJoiner',

  addOptions() {
    return { elementsToJoin: [] };
  },

  addProseMirrorPlugins() {
    const kinds = [this.editor.schema.nodes.bulletList, this.editor.schema.nodes.orderedList];
    for (const name of this.options.elementsToJoin) {
      kinds.push(getNodeType(name, this.editor.schema));
    }

    return [
      new Plugin({
        key: new PluginKey(this.name),
        appendTransaction(transactions, _before, after) {
          const next = after.tr;
          return autoJoin(transactions, next, kinds.filter(Boolean)) ? next : undefined;
        }
      })
    ];
  }
});
