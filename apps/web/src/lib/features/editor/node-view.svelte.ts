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

import { mount, unmount, untrack } from 'svelte';
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
  /**
   * Постоянные доводы отображения: чем показывать вложение, строчная формула
   * или блочная.
   *
   * Передаются здесь, а не обёрткой над компонентом. Обёртка складывала бы их
   * с доводами узла через `{ ...props }`, то есть снимала бы с них снимок, и
   * отображение переставало бы видеть и выделение, и смену режима, и правку
   * атрибутов — всё, что мост пишет после создания.
   */
  extra?: Record<string, unknown>;
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
      ...options.extra,
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
            // Прежние значения берутся из документа, а не из узла, с которым
            // отображение завели. Тот узел — снимок на миг создания, и правка
            // поверх него возвращает всё, что записали после: у статуса выбор
            // цвета стирал уже набранный текст.
            const current = tr.doc.nodeAt(position);
            if (!current) return false;
            tr.setNodeMarkup(position, undefined, {
              ...current.attrs,
              ...values
            });
            return true;
          })
          .run();
      }
    });

    /**
     * Переключение режима чтения и правки.
     *
     * Через `update` отображения оно не приходит: `setEditable` документа не
     * меняет, а ProseMirror переиспользует совпавшие узлы, не спрашивая их
     * отображения. Без этой подписки уже нарисованный узел остаётся в прежнем
     * режиме до первой своей правки — метка состояния не нажимается, выбор
     * вида выноски не показывается.
     *
     * Вне отслеживания: `setEditable` вызывается из эффекта, и запись отсюда
     * подписала бы тот эффект на то, что он же и меняет.
     */
    const refreshEditable = () => {
      untrack(() => {
        state.editable = props.editor.isEditable;
      });
    };
    props.editor.on('update', refreshEditable);

    const instance = mount(view, { target: dom, props: state });

    // Узел содержимого создаётся здесь, а не компонентом: его адрес нужен
    // редактору целиком, и пересоздание при перерисовке оборвало бы правку.
    let contentDOM: HTMLElement | undefined;
    if (options.content) {
      // Помеченный компонентом узел становится узлом содержимого сам, а не
      // получает вложенную обёртку. Обёртка вставила бы лишний блок внутрь
      // разметки узла — в блоке кода это `<div>` внутри `<code>`, и подсветка
      // с переносами строк разъезжаются.
      const slot = dom.querySelector<HTMLElement>('[data-node-view-content]');
      if (slot) contentDOM = slot;
      else {
        contentDOM = document.createElement(options.inline ? 'span' : 'div');
        dom.appendChild(contentDOM);
      }
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
        props.editor.off('update', refreshEditable);
        void unmount(instance);
      }
    };
  };
}
