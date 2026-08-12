<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { children: Snippet };
  const { children }: Props = $props();
</script>

<!-- Страница по ссылке открывается без входа, поэтому здесь нет ни дерева
     пространств, ни выхода из учётной записи: показывать их некому. -->
<div data-section="share" class="min-h-screen bg-surface-muted px-4 py-10 text-text">
  <div class="mx-auto max-w-3xl">
    {@render children()}
  </div>
</div>
