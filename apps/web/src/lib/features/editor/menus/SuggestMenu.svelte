<script lang="ts">
  import type { SuggestItem } from '../suggest';

  type Props = {
    items: SuggestItem[];
    /** Выбранная строка. Двигается с клавиатуры, ведёт себя как в списке. */
    index: number;
    /** Где открыть: точка запятнателя в окне браузера. */
    at: { left: number; top: number; bottom: number };
    /** Идёт запрос к серверу: перечень ещё не полон. */
    loading?: boolean;
    empty: string;
    onpick: (item: SuggestItem, index: number) => void;
    onhover: (index: number) => void;
  };
  const { items, index, at, loading = false, empty, onpick, onhover }: Props = $props();

  /** Предельная высота перечня. По ней же решается, куда его раскрывать. */
  const MAX_HEIGHT = 320;

  let list: HTMLDivElement | undefined = $state();

  /** Снизу не хватает места, а сверху хватает — перечень раскрывается вверх. */
  const flipped = $derived(
    typeof window !== 'undefined' &&
      at.bottom + MAX_HEIGHT > window.innerHeight &&
      at.top > MAX_HEIGHT
  );

  // Выбранная строка держится в виду: при движении с клавиатуры она уходит за
  // край перечня, и человек двигает выбор вслепую.
  $effect(() => {
    void index;
    list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div
  bind:this={list}
  data-component="SuggestMenu"
  class="fixed z-50 max-h-80 w-72 overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
  style:left="{at.left}px"
  style:top={flipped ? 'auto' : `${at.bottom + 4}px`}
  style:bottom={flipped ? `${window.innerHeight - at.top + 4}px` : 'auto'}
  role="listbox"
  tabindex="-1"
>
  {#if items.length === 0}
    <p class="px-3 py-2 text-sm text-text-muted">{loading ? '…' : empty}</p>
  {:else}
    {#each items as item, row (item.key)}
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text hover:bg-surface-hover"
        class:bg-surface-active={row === index}
        type="button"
        role="option"
        aria-selected={row === index}
        onmouseenter={() => onhover(row)}
        onclick={() => onpick(item, row)}
      >
        {#if item.glyph}
          <span class="w-5 shrink-0 text-center text-base leading-none">{item.glyph}</span>
        {:else if item.icon}
          {@const Icon = item.icon}
          <span class="w-5 shrink-0 text-text-muted"><Icon size={17} stroke={1.7} /></span>
        {/if}
        <span class="truncate">{item.label}</span>
        {#if item.hint}
          <span class="ml-auto truncate text-xs text-text-muted">{item.hint}</span>
        {/if}
      </button>
    {/each}
  {/if}
</div>
