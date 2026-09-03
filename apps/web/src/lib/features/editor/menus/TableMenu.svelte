<script lang="ts">
  import {
    IconAlignCenter,
    IconAlignLeft,
    IconAlignRight,
    IconArrowsJoin,
    IconArrowsSplit,
    IconColumnInsertLeft,
    IconColumnInsertRight,
    IconColumnRemove,
    IconLayoutNavbar,
    IconRowInsertBottom,
    IconRowInsertTop,
    IconRowRemove,
    IconTableOff
  } from '@tabler/icons-svelte';
  import type { Editor } from '@tiptap/core';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = { editor: Editor };
  const { editor }: Props = $props();

  const t = $derived(locale.t);
</script>

{#snippet action(Icon: typeof IconRowInsertTop, label: string, run: () => void)}
  <button
    class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
    type="button"
    title={label}
    aria-label={label}
    onclick={run}
  >
    <Icon size={17} stroke={1.7} />
  </button>
{/snippet}

<!--
  Панель таблицы стоит над самой таблицей, а не всплывает у курсора: действий
  тринадцать, и всплывающее окно такой ширины перекрывало бы правимую ячейку.
-->
<div
  data-component="TableMenu"
  class="mb-2 flex flex-wrap items-center gap-0.5 rounded-md border border-border bg-surface-raised p-1"
>
  {@render action(IconRowInsertTop, t('Insert row above'), () =>
    editor.chain().focus().addRowBefore().run()
  )}
  {@render action(IconRowInsertBottom, t('Insert row below'), () =>
    editor.chain().focus().addRowAfter().run()
  )}
  {@render action(IconRowRemove, t('Delete row'), () => editor.chain().focus().deleteRow().run())}

  <span class="mx-1 h-5 w-px bg-border"></span>

  {@render action(IconColumnInsertLeft, t('Insert column left'), () =>
    editor.chain().focus().addColumnBefore().run()
  )}
  {@render action(IconColumnInsertRight, t('Insert column right'), () =>
    editor.chain().focus().addColumnAfter().run()
  )}
  {@render action(IconColumnRemove, t('Delete column'), () =>
    editor.chain().focus().deleteColumn().run()
  )}

  <span class="mx-1 h-5 w-px bg-border"></span>

  {@render action(IconLayoutNavbar, t('Toggle header row'), () =>
    editor.chain().focus().toggleHeaderRow().run()
  )}
  {@render action(IconArrowsJoin, t('Merge cells'), () =>
    editor.chain().focus().mergeCells().run()
  )}
  {@render action(IconArrowsSplit, t('Split cell'), () => editor.chain().focus().splitCell().run())}

  <span class="mx-1 h-5 w-px bg-border"></span>

  {@render action(IconAlignLeft, t('Align left'), () =>
    editor.chain().focus().setTextAlign('left').run()
  )}
  {@render action(IconAlignCenter, t('Align center'), () =>
    editor.chain().focus().setTextAlign('center').run()
  )}
  {@render action(IconAlignRight, t('Align right'), () =>
    editor.chain().focus().setTextAlign('right').run()
  )}

  <span class="mx-1 h-5 w-px bg-border"></span>

  {@render action(IconTableOff, t('Delete table'), () =>
    editor.chain().focus().deleteTable().run()
  )}
</div>
