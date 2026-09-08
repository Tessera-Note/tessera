<script lang="ts">
  import { IconGripVertical, IconPlus } from '@tabler/icons-svelte';
  import type { Editor } from '@tiptap/core';
  import { NodeSelection } from '@tiptap/pm/state';
  import type { Slice } from '@tiptap/pm/model';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    editor: Editor;
    /** Открыть перечень вставки под ручкой. */
    oninsert: (at: { left: number; top: number; bottom: number }) => void;
  };
  const { editor, oninsert }: Props = $props();

  const t = $derived(locale.t);

  /** Блок под указателем: его начало в документе и его прямоугольник. */
  let target = $state<{ pos: number; left: number; top: number; height: number } | null>(null);

  /**
   * Найти блок верхнего уровня под указателем.
   *
   * Именно верхнего: перетаскивать абзац из ячейки таблицы отдельно от таблицы
   * нельзя — он уедет наружу и разрушит строку.
   */
  function locate(event: MouseEvent) {
    const view = editor.view;
    const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (!found) {
      target = null;
      return;
    }

    // Разрешается именно `pos`, а не `inside`. `inside` — это позиция перед
    // узлом под указателем, и её глубина на один меньше: у блока верхнего
    // уровня она равна нулю, и подъём к первому уровню оттуда невозможен.
    const at = editor.state.doc.resolve(found.pos);
    if (at.depth < 1) {
      target = null;
      return;
    }

    const pos = at.before(1);
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) {
      target = null;
      return;
    }

    const box = dom.getBoundingClientRect();
    target = { pos, left: box.left, top: box.top, height: box.height };
  }

  /** Выделить блок целиком. Так же ведёт себя нажатие на ручку. */
  function select(pos: number): boolean {
    try {
      const selection = NodeSelection.create(editor.state.doc, pos);
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      return true;
    } catch {
      // Узел не выделяется целиком: у него нет собственной позиции в схеме.
      return false;
    }
  }

  /**
   * Начать перетаскивание.
   *
   * Кусок кладётся в `view.dragging` вручную: браузер сам знает только текст,
   * а нужен узел документа со всеми его свойствами. Без этого перетащенная
   * врезка приходит на новое место голым абзацем.
   */
  function dragstart(event: DragEvent) {
    if (!target || !event.dataTransfer) return;
    if (!select(target.pos)) {
      event.preventDefault();
      return;
    }

    const dom = editor.view.nodeDOM(target.pos);
    const slice: Slice = editor.state.selection.content();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/html', '');
    if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);

    // `dragging` в типе помечено только для чтения, но подмена куска — часть
    // обычного порядка ProseMirror: так же поступает его собственная ручка.
    (editor.view as unknown as { dragging: { slice: Slice; move: boolean } | null }).dragging = {
      slice,
      move: true
    };
  }

  function dragend() {
    (editor.view as unknown as { dragging: unknown }).dragging = null;
  }
</script>

<svelte:window onmousemove={locate} />

{#if target && editor.isEditable}
  <div
    data-component="DragHandle"
    class="fixed z-30 flex items-center gap-0.5"
    style:left="{target.left - 52}px"
    style:top="{target.top}px"
    style:height="{Math.min(target.height, 28)}px"
  >
    <button
      class="flex h-6 w-6 items-center justify-center rounded text-text-muted opacity-60 hover:bg-surface-hover hover:opacity-100"
      type="button"
      title={t('Insert block')}
      aria-label={t('Insert block')}
      onclick={() =>
        target && oninsert({ left: target.left - 52, top: target.top, bottom: target.top + 24 })}
    >
      <IconPlus size={16} stroke={1.7} />
    </button>
    <button
      class="flex h-6 w-6 cursor-grab items-center justify-center rounded text-text-muted opacity-60 hover:bg-surface-hover hover:opacity-100"
      type="button"
      draggable="true"
      title={t('Drag to move')}
      aria-label={t('Drag to move')}
      ondragstart={dragstart}
      ondragend={dragend}
      onclick={() => target && select(target.pos)}
    >
      <IconGripVertical size={16} stroke={1.7} />
    </button>
  </div>
{/if}
