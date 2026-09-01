/**
 * Отображение узла редактора компонентом Svelte.
 *
 * В общем пакете `@tessera/editor-ext` отображения написаны на React: пакет
 * общий с v1, и переписывать его значило бы завести вторую схему узлов. Здесь
 * же нужен свой рисовальщик, поэтому расширение берётся как есть, а отображение
 * подменяется этим помощником.
 *
 * Обновление идёт через рунический объект свойств: Tiptap зовёт `update` при
 * каждой правке узла, и пересоздавать компонент на каждую правку значило бы
 * терять фокус и состояние — в поле ввода это заметно сразу.
 */

import { mount, unmount } from 'svelte';
import type { Component } from 'svelte';
import type { Editor, NodeViewRenderer } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** Что получает отображение узла. */
export type NodeViewProps = {
  node: ProseMirrorNode;
  attributes: Record<string, unknown>;
  selected: boolean;
  editable: boolean;
  editor: Editor;
  /** Записать атрибуты узла. Пишет сам редактор, а не компонент. */
  updateAttributes: (values: Record<string, unknown>) => void;
};

type Options = {
  /** Строчный узел живёт внутри абзаца, поэтому и обёртка строчная. */
  inline?: boolean;
};

export function svelteNodeView(
  view: Component<NodeViewProps>,
  options: Options = {}
): NodeViewRenderer {
  return (props) => {
    const dom = document.createElement(options.inline ? 'span' : 'div');
    dom.setAttribute('data-node-view', props.node.type.name);
    if (options.inline) dom.style.display = 'inline-block';

    const state = $state<NodeViewProps>({
      node: props.node,
      attributes: { ...props.node.attrs },
      selected: false,
      editable: props.editor.isEditable,
      editor: props.editor as Editor,
      updateAttributes: (values) => {
        if (typeof props.getPos !== 'function') return;
        const position = props.getPos();
        if (position === undefined) return;
        props.editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(position, undefined, {
              ...props.node.attrs,
              ...values
            });
            return true;
          })
          .run();
      }
    });

    const instance = mount(view, { target: dom, props: state });

    return {
      dom,

      update(updated) {
        if (updated.type !== props.node.type) return false;
        state.node = updated;
        state.attributes = { ...updated.attrs };
        state.editable = props.editor.isEditable;
        return true;
      },

      selectNode() {
        state.selected = true;
      },

      deselectNode() {
        state.selected = false;
      },

      // Узел не содержит текста редактора: правки внутри него идут своими
      // средствами, и пропускать сюда события редактора нельзя.
      stopEvent: () => true,
      ignoreMutation: () => true,

      destroy() {
        void unmount(instance);
      }
    };
  };
}
