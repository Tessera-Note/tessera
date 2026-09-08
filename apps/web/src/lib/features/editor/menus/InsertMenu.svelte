<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import { locale } from '$lib/stores/i18n.svelte';
  import { blockActions } from '../actions';
  import { blockIcon } from '../block-icons';
  import { BLOCKS, findBlocks, type Block, type BlockContext } from '../blocks';

  type Props = {
    editor: Editor;
    /** Страница, к которой привязываются файлы и базы. Пусто у шаблона. */
    pageId: string;
    at: { left: number; top: number; bottom: number };
    /** Какие блоки предлагать. Умолчание — все. */
    blocks?: readonly Block[];
    fail: (error: unknown) => void;
    onclose: () => void;
  };
  const { editor, pageId, at, blocks = BLOCKS, fail, onclose }: Props = $props();

  const t = $derived(locale.t);

  let query = $state('');
  let field: HTMLInputElement | undefined = $state();

  $effect(() => {
    field?.focus();
  });

  const found = $derived(findBlocks(query, t, blocks));

  /** Подписи разделов. Английские — это ключи словаря, как и всюду. */
  const SECTIONS: { group: 'basic' | 'media' | 'embed'; label: string }[] = [
    { group: 'basic', label: 'Basic blocks' },
    { group: 'media', label: 'Media' },
    { group: 'embed', label: 'Embeds' }
  ];

  function pick(id: string) {
    const block = blocks.find((one) => one.id === id);
    if (!block) return;
    onclose();
    const context: BlockContext = {
      editor,
      pageId,
      locale: locale.current,
      fail,
      ...blockActions(editor, pageId, fail)
    };
    block.run(context);
  }

  const HEIGHT = 360;
  const flipped = $derived(
    typeof window !== 'undefined' && at.bottom + HEIGHT > window.innerHeight && at.top > HEIGHT
  );
</script>

<div
  data-component="InsertMenu"
  class="fixed z-50 flex max-h-96 w-72 flex-col rounded-md border border-border bg-surface-raised shadow-lg"
  style:left="{at.left}px"
  style:top={flipped ? 'auto' : `${at.bottom + 4}px`}
  style:bottom={flipped ? `${window.innerHeight - at.top + 4}px` : 'auto'}
>
  <input
    bind:this={field}
    bind:value={query}
    class="m-1 h-8 rounded bg-surface px-2 text-sm text-text outline-none placeholder:text-text-muted"
    type="search"
    placeholder={t('Search')}
    aria-label={t('Search')}
    onkeydown={(event) => event.key === 'Escape' && onclose()}
  />

  <div class="overflow-y-auto pb-1">
    {#each SECTIONS as section (section.group)}
      {@const items = found.filter((block) => block.group === section.group)}
      {#if items.length}
        <p class="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          {t(section.label)}
        </p>
        {#each items as block (block.id)}
          {@const Icon = blockIcon(block.id)}
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text hover:bg-surface-hover"
            type="button"
            onclick={() => pick(block.id)}
          >
            <span class="w-5 shrink-0 text-text-muted"><Icon size={17} stroke={1.7} /></span>
            <span class="truncate">{t(block.label)}</span>
          </button>
        {/each}
      {/if}
    {/each}

    {#if found.length === 0}
      <p class="px-3 py-2 text-sm text-text-muted">{t('No results')}</p>
    {/if}
  </div>
</div>
