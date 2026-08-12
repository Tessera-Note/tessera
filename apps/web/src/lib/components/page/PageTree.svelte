<script lang="ts">
  import { page as current } from '$app/state';
  import { pageTree, type PageSummary } from '$lib/features/page/services/pages';
  import { locale } from '$lib/stores/i18n.svelte';
  import PageTreeNode from './PageTreeNode.svelte';

  type Props = { spaceId: string; spaceSlug: string };
  const { spaceId, spaceSlug }: Props = $props();

  let roots = $state<PageSummary[]>([]);
  let loading = $state(true);

  const t = $derived(locale.t);

  // Корень перезапрашивается при смене пространства: держать в памяти дерево
  // каждого посещённого пространства значит показывать устаревшее после того,
  // как страницу завели в другой вкладке.
  $effect(() => {
    const wanted = spaceId;
    loading = true;
    pageTree(wanted, null)
      .then((found) => {
        if (wanted === spaceId) roots = found;
      })
      .catch(() => {
        // Отказ дерева не должен ронять экран: страница открывается по прямой
        // ссылке и без дерева.
        if (wanted === spaceId) roots = [];
      })
      .finally(() => {
        if (wanted === spaceId) loading = false;
      });
  });
</script>

<div data-component="PageTree" class="space-y-0.5">
  {#if loading}
    <p class="px-2 py-1 text-sm text-text-muted">{t('Loading...')}</p>
  {:else}
    {#each roots as node (node.id)}
      <PageTreeNode {node} {spaceSlug} depth={0} activeSlug={current.params.pageSlug} />
    {:else}
      <p class="px-2 py-1 text-sm text-text-muted">{t('No pages in this space')}</p>
    {/each}
  {/if}
</div>
