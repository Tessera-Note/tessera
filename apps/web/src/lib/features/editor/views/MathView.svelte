<script lang="ts">
  import 'katex/dist/katex.min.css';
  import katex from 'katex';
  import { IconTrash } from '@tabler/icons-svelte';
  import { untrack } from 'svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps & {
    /** Отдельной строкой по центру или внутри текста. */
    display: boolean;
  };
  const {
    node,
    attributes,
    selected,
    editable,
    editor,
    updateAttributes,
    position,
    display
  }: Props = $props();

  const t = $derived(locale.t);

  const text = $derived(String(attributes.text ?? ''));

  /**
   * Что показано и что правится — разные строки.
   *
   * Пока идёт набор, в узел писать нельзя на каждое нажатие: правка узла это
   * правка общего документа, и она уходит всем соседям. Набранное живёт здесь,
   * а в узел попадает по закрытию окна.
   */
  let draft = $state('');
  let editing = $state(false);
  let field: HTMLTextAreaElement | undefined = $state();

  /** Отрисовать формулу в готовый узел разметки. Отказ возвращается текстом. */
  function draw(source: string, into: HTMLElement | undefined): string | null {
    if (!into) return null;
    try {
      katex.render(source, into, { displayMode: display, strict: false });
      return null;
    } catch (failure) {
      return failure instanceof Error ? failure.message : String(failure);
    }
  }

  let shown: HTMLElement | undefined = $state();
  let preview: HTMLElement | undefined = $state();
  let failure = $state<string | null>(null);

  $effect(() => {
    failure = draw(text, shown);
  });

  $effect(() => {
    if (editing) draw(draft, preview);
  });

  $effect(() => {
    if (editing) field?.focus();
  });

  /**
   * Окно правки открывается выделением узла целиком.
   *
   * Так же, как в v1: у формулы нет своего содержимого в документе, и войти в
   * неё кареткой нельзя — остаётся выделение.
   */
  $effect(() => {
    const chosen = selected && editable;
    untrack(() => {
      if (chosen === editing) return;
      if (chosen) draft = text;
      else if (draft !== text) updateAttributes({ text: draft.trim() });
      editing = chosen;
    });
  });

  /** Уйти за формулу: правка окончена, каретка встаёт после узла. */
  function leave() {
    const at = position();
    if (at !== undefined) editor.commands.focus(at + node.nodeSize);
  }

  function drop() {
    const at = position();
    if (at === undefined) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: at, to: at + node.nodeSize })
      .run();
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      leave();
      return;
    }

    const box = event.currentTarget as HTMLTextAreaElement;
    const caret = box.selectionStart === box.selectionEnd ? box.selectionStart : null;
    if (caret === null) return;

    // Стрелка у края поля выводит каретку из формулы, а не двигает её внутри:
    // иначе из окна правки нет выхода клавиатурой.
    if (event.key === 'ArrowLeft' && caret === 0) {
      const at = position();
      if (at !== undefined) editor.commands.focus(at);
    }
    if (event.key === 'ArrowRight' && caret === box.value.length) leave();
  }

  const empty = $derived(editing ? draft.trim().length === 0 : text.trim().length === 0);
</script>

<svelte:element
  this={display ? 'div' : 'span'}
  data-component="MathView"
  data-katex="true"
  class="tessera-math"
  class:tessera-math-block={display}
  class:tessera-math-empty={empty}
  class:tessera-math-error={failure !== null}
  class:tessera-math-selected={selected}
>
  <!-- Показанная формула и предпросмотр набираемой: обе нарисованы, видна одна. -->
  <span bind:this={preview} hidden={!editing}></span>
  <span bind:this={shown} hidden={editing}></span>
  {#if empty}<span>{t('Empty equation')}</span>{/if}
  {#if failure !== null && !empty}<span>{t('Invalid equation')}</span>{/if}

  {#if editing}
    <span
      class="absolute left-0 top-full z-50 mt-1 flex w-96 max-w-[80vw] items-start gap-1 rounded-md border border-border bg-surface-raised p-2 text-left shadow-lg"
      role="dialog"
      aria-label={display ? t('Math block') : t('Math inline')}
    >
      <textarea
        bind:this={field}
        class="h-16 min-w-0 flex-1 resize-none rounded border border-border-input bg-surface px-2 py-1 font-mono text-sm text-text outline-none focus:border-accent"
        value={draft}
        placeholder="E = mc^2"
        aria-label={display ? t('Math block') : t('Math inline')}
        oninput={(event) => (draft = event.currentTarget.value)}
        onkeydown={keydown}
      ></textarea>
      {#if display}
        <button
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-danger"
          type="button"
          title={t('Delete')}
          aria-label={t('Delete')}
          onclick={drop}
        >
          <IconTrash size={16} stroke={1.7} />
        </button>
      {/if}
    </span>
  {/if}
</svelte:element>
