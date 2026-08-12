<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    title?: string;
    /** Пояснение под заголовком: зачем раздел и что он меняет. */
    hint?: string;
    children: Snippet;
  };
  const { title, hint, children }: Props = $props();
</script>

<section data-component="Panel" class="mb-8 rounded-lg border border-border bg-surface-raised p-6">
  {#if title}
    <h2 class="mb-1 text-lg font-medium">{title}</h2>
  {/if}
  {#if hint}
    <p class="mb-4 text-sm text-text-muted">{hint}</p>
  {:else if title}
    <div class="mb-4"></div>
  {/if}
  {@render children()}
</section>
