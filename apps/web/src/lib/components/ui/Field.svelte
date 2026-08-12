<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    label: string;
    /** Подсказка под полем. Отказ показывается отдельно и красным. */
    hint?: string;
    children: Snippet;
  };
  const { label, hint, children }: Props = $props();
</script>

<label data-component="Field" class="mb-4 block">
  <span class="mb-1 block text-sm text-text-muted">{label}</span>
  {@render children()}
  {#if hint}
    <span class="mt-1 block text-xs text-text-muted">{hint}</span>
  {/if}
</label>
