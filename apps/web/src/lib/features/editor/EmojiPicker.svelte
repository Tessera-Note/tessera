<script lang="ts">
  import { IconX } from '@tabler/icons-svelte';
  import { emojiSet, findEmoji, rememberEmoji } from './emoji';
  import type { EmojiRow } from './emoji-data';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Что выбрано сейчас: у него показывается кнопка снятия. */
    current?: string | null;
    onpick: (emoji: string) => void;
    onclear?: () => void;
    onclose: () => void;
  };
  const { current = null, onpick, onclear, onclose }: Props = $props();

  const t = $derived(locale.t);

  let query = $state('');
  let set = $state<readonly EmojiRow[]>([]);
  let field: HTMLInputElement | undefined = $state();

  $effect(() => {
    // Набор читается по требованию: сто тридцать килобайт нужны только тому,
    // кто открыл выбор значка.
    void emojiSet().then((rows) => (set = rows));
    field?.focus();
  });

  /**
   * Что показывать.
   *
   * На пустом запросе — выбранное прежде, а если такого нет, начало набора:
   * пустая рамка выглядит поломкой, а не приглашением искать.
   */
  const found = $derived.by(() => {
    const rows = findEmoji(query, set);
    if (rows.length > 0 || query.trim()) return rows;
    return set.slice(0, 48);
  });
</script>

<div
  data-component="EmojiPicker"
  class="absolute z-40 mt-1 w-72 rounded-md border border-border bg-surface-raised p-2 shadow-lg"
  role="dialog"
  aria-label={t('Choose icon')}
>
  <div class="mb-2 flex items-center gap-1">
    <input
      bind:this={field}
      bind:value={query}
      class="h-8 flex-1 rounded bg-surface px-2 text-sm outline-none placeholder:text-text-muted"
      type="search"
      placeholder={t('Search')}
      aria-label={t('Search')}
      onkeydown={(event) => event.key === 'Escape' && onclose()}
    />
    <button
      class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
      type="button"
      title={t('Close')}
      aria-label={t('Close')}
      onclick={onclose}
    >
      <IconX size={16} stroke={1.7} />
    </button>
  </div>

  <div class="grid max-h-56 grid-cols-8 gap-1 overflow-y-auto">
    {#each found as row (row[1])}
      <button
        class="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-surface-hover"
        type="button"
        title={row[1]}
        aria-label={row[1]}
        onclick={() => {
          rememberEmoji(row[1]);
          onpick(row[0]);
        }}
      >
        {row[0]}
      </button>
    {/each}
  </div>

  {#if current && onclear}
    <button
      class="mt-2 w-full rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover"
      type="button"
      onclick={onclear}
    >
      {t('Remove icon')}
    </button>
  {/if}
</div>
