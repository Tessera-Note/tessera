<script lang="ts">
  import { readRichText } from '$lib/features/page/rich-text';

  type Props = { content: unknown };
  const { content }: Props = $props();

  const lines = $derived(readRichText(content));
</script>

<!--
  Показ тела комментария. Правит его настоящий редактор, а здесь только чтение:
  на странице обсуждений бывает полсотни, и полсотни редакторов ради трёх строк
  это полсотни наборов расширений в памяти.
-->
<div data-component="RichText" class="text-sm">
  {#each lines as line, at (at)}
    {#snippet pieces()}
      {#each line.pieces as piece, index (index)}
        {#if piece.kind === 'mention'}
          {#if piece.page && piece.slugId}
            <a
              class="rounded bg-accent-soft px-1 text-accent no-underline"
              href="/p/{piece.slugId}"
            >
              {piece.label}
            </a>
          {:else}
            <span class="rounded bg-accent-soft px-1 text-accent">
              {piece.page ? '' : '@'}{piece.label}
            </span>
          {/if}
        {:else if piece.href}
          <a class="text-accent underline" href={piece.href} rel="noreferrer noopener">
            {piece.text}
          </a>
        {:else}
          <span
            class:font-semibold={piece.bold}
            class:italic={piece.italic}
            class:line-through={piece.strike}
            class:rounded={piece.code}
            class:bg-surface-hover={piece.code}
            class:px-1={piece.code}
            class:font-mono={piece.code}>{piece.text}</span
          >
        {/if}
      {/each}
    {/snippet}

    {#if line.block === 'quote'}
      <blockquote class="my-1 border-l-2 border-border pl-2 text-text-muted">
        {@render pieces()}
      </blockquote>
    {:else if line.block === 'code'}
      <pre
        class="my-1 overflow-x-auto rounded bg-surface-hover px-2 py-1 font-mono text-xs">{@render pieces()}</pre>
    {:else if line.block === 'item'}
      <p class="my-0.5 pl-4">• {@render pieces()}</p>
    {:else}
      <p class="my-0.5">{@render pieces()}</p>
    {/if}
  {/each}
</div>
