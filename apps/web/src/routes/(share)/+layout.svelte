<script lang="ts">
  import { onMount } from 'svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { Snippet } from 'svelte';

  type Props = { children: Snippet };
  const { children }: Props = $props();

  const t = $derived(locale.t);

  // Тему читает корневой слой, но переключателя здесь не было: он живёт в
  // шапке рабочих экранов, а её на странице по ссылке нет. В v1 переключатель
  // стоит и здесь — читают по ссылке в том числе ночью.
  onMount(() => theme.hydrate());
</script>

<!-- Страница по ссылке открывается без входа, поэтому здесь нет ни дерева
     пространств, ни выхода из учётной записи: показывать их некому. -->
<div data-section="share" class="min-h-screen bg-surface-muted px-4 py-10 text-text">
  <div class="mx-auto max-w-3xl">
    <div class="mb-4 flex justify-end">
      <button
        class="rounded border border-border px-3 py-1.5 text-sm font-medium text-text-muted hover:bg-surface"
        type="button"
        onclick={() => theme.toggle()}
      >
        {theme.current === 'dark' ? t('Light mode') : t('Dark mode')}
      </button>
    </div>
    {@render children()}
  </div>
</div>
