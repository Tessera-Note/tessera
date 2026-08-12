<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { children: Snippet };
  const { children }: Props = $props();
</script>

<div
  data-section="auth"
  class="flex min-h-screen items-center justify-center bg-surface-muted px-4 py-12"
>
  <div class="w-full max-w-sm">
    {@render children()}
  </div>
</div>
