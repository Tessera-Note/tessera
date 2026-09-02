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
  /**
   * Где узел стоит в документе.
   *
   * Нужен тем отображениям, которые заменяют себя целиком: текущее выделение
   * для этого не годится — оно может быть где угодно, и вставка ушла бы не на
   * место узла. `undefined` означает, что узел уже вынут из документа.
   */
  position: () => number | undefined;
};

type Options = {
  /** Строчный узел живёт внутри абзаца, поэтому и обёртка строчная. */
  inline?: boolean;
  /**
   * У узла есть содержимое, которое правит сам редактор.
   *
   * Тогда компонент рисует только обрамление и оставляет место меткой
   * `data-node-view-content`; настоящий узел содержимого туда подставляет
   * помощник. Своими руками рисовать содержимое нельзя: это узлы документа, и
   * подменённые показом они перестают правиться.
   */
  content?: boolean;
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
      position: () => (typeof props.getPos === 'function' ? props.getPos() : undefined),
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

    // Узел содержимого создаётся здесь, а не компонентом: его адрес нужен
    // редактору целиком, и пересоздание при перерисовке оборвало бы правку.
    let contentDOM: HTMLElement | undefined;
    if (options.content) {
      contentDOM = document.createElement(options.inline ? 'span' : 'div');
      const slot = dom.querySelector('[data-node-view-content]');
      (slot ?? dom).appendChild(contentDOM);
    }

    return {
      dom,
      contentDOM,

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

      // У узла без содержимого правки идут своими средствами, и события
      // редактора сюда пропускать нельзя. У узла с содержимым — наоборот:
      // перехват событий означал бы, что внутри блока ничего не набирается.
      stopEvent: () => !options.content,
      ignoreMutation: (mutation) =>
        options.content
          ? // Правку внутри содержимого редактор разбирает сам; всё, что
            // происходит в обрамлении, его не касается.
            !contentDOM || !contentDOM.contains(mutation.target)
          : true,

      destroy() {
        void unmount(instance);
      }
    };
  };
}
