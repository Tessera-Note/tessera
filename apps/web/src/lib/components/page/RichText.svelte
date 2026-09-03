<script lang="ts">
  import MentionChip from '$lib/components/page/MentionChip.svelte';
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
          <!--
            Тот же показ, что в теле страницы: подпись в узле заморожена при
            вставке, и без разрешения имя удалённого осталось бы в обсуждении
            даже после того, как ушло со страницы.
          -->
          <MentionChip
            page={piece.page}
            label={piece.label}
            entityId={piece.entityId}
            slugId={piece.slugId}
            anchorId={piece.anchorId}
          />
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
