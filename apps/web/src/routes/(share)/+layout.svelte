<script lang="ts">
  import { onMount } from 'svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import { shareWidth } from '$lib/features/share/width.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { Snippet } from 'svelte';

  type Props = { children: Snippet };
  const { children }: Props = $props();

  const t = $derived(locale.t);

  // Тему читает корневой слой, но переключателя здесь не было: он живёт в
  // шапке рабочих экранов, а её на странице по ссылке нет. В v1 переключатель
  // стоит и здесь — читают по ссылке в том числе ночью.
  onMount(() => {
    theme.hydrate();
    shareWidth.hydrate();
  });
</script>

<!-- Страница по ссылке открывается без входа, поэтому здесь нет ни дерева
     пространств, ни выхода из учётной записи: показывать их некому. -->
<div data-section="share" class="min-h-screen bg-surface-muted px-4 py-10 text-text">
  <div class="mx-auto" class:max-w-3xl={!shareWidth.wide}>
    <div class="mb-4 flex justify-end gap-2">
      <!-- Ширина листа. У постороннего читателя настроек нет, и это
           единственное место, где он может расширить лист под таблицу. -->
      <button
        class="rounded border border-border px-3 py-1.5 text-sm font-medium text-text-muted hover:bg-surface"
        type="button"
        aria-pressed={shareWidth.wide}
        onclick={() => shareWidth.toggle()}
      >
        {shareWidth.wide ? t('Narrow page') : t('Full width')}
      </button>
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
