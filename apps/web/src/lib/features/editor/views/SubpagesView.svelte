<script lang="ts">
  import { page as current } from '$app/state';
  import { pageTree, type PageSummary } from '$lib/features/page/services/pages';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps;
  const { selected }: Props = $props();

  const t = $derived(locale.t);

  let children = $state<PageSummary[] | null>(null);
  let failed = $state(false);

  /**
   * Список подстраниц.
   *
   * Он не хранится в документе, а спрашивается у сервера: подстраницы заводят и
   * переносят мимо этого узла, и записанный однажды перечень разошёлся бы с
   * деревом при первом же переносе.
   */
  $effect(() => {
    // Страница берётся из данных экрана: узел живёт внутри неё, и держать
    // второй источник этого же значения незачем.
    const host = current.data?.page as { id: string; spaceId: string } | undefined;
    if (children !== null || !host) return;

    children = [];
    void (async () => {
      try {
        children = await pageTree(host.spaceId, host.id);
      } catch {
        failed = true;
      }
    })();
  });

  const spaceSlug = $derived((current.data?.space?.slug as string | undefined) ?? '');
</script>

<nav
  data-component="SubpagesView"
  class="my-2 rounded border border-border p-3"
  class:outline={selected}
  class:outline-2={selected}
  class:outline-accent={selected}
>
  <p class="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
    {t('Subpages')}
  </p>

  {#if failed}
    <p class="text-sm text-text-muted">{t('Failed to load subpages')}</p>
  {:else if children === null}
    <p class="text-sm text-text-muted">{t('Loading...')}</p>
  {:else}
    <ul class="space-y-1">
      {#each children as child (child.id)}
        <li>
          <a class="text-sm hover:underline" href="/s/{spaceSlug}/p/{child.slugId}">
            {#if child.icon}<span class="mr-1">{child.icon}</span>{/if}
            {child.title ?? t('Untitled')}
          </a>
        </li>
      {:else}
        <li class="text-sm text-text-muted">{t('No pages inside')}</li>
      {/each}
    </ul>
  {/if}
</nav>
