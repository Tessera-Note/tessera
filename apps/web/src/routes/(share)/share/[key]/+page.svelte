<script lang="ts">
  import PageBody from '$lib/components/page/PageBody.svelte';
  import { errorText } from '$lib/api/failure';
  import { searchShared, type SharedHit } from '$lib/features/share/services/share';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  const when = $derived(
    new Intl.DateTimeFormat(locale.current, { dateStyle: 'medium' }).format(
      new Date(data.page.updatedAt)
    )
  );

  //: Дерево показывается только там, где оно есть: ссылка без подстраниц
  //: отдаёт один корень, и панель из одной строки лишняя.
  const branch = $derived(data.tree?.pageTree ?? []);
  const hasBranch = $derived(branch.length > 1);

  /** Прямые потомки узла. Дерево приходит плоским списком. */
  function childrenOf(parent: string | null) {
    return branch.filter((one) => one.parentPageId === parent);
  }

  const rootId = $derived(data.tree?.rootId ?? null);

  let query = $state('');
  let hits = $state<SharedHit[] | null>(null);
  let searching = $state(false);
  let failure = $state<string | null>(null);

  async function search(event: SubmitEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text) {
      hits = null;
      return;
    }
    searching = true;
    failure = null;
    try {
      // Поиск идёт по опубликованной ветви и за её пределы не выходит: отбор
      // задаёт тот же ключ, что открыл страницу.
      hits = await searchShared(data.key, text);
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      searching = false;
    }
  }
</script>

<svelte:head>
  <title>{data.page.title ?? t('Untitled')}</title>
  <!-- Индексацией управляет признак самой ссылки: пока он не включён,
       страница закрыта от поисковых машин. -->
  {#if !data.page.share?.searchIndexing}
    <meta name="robots" content="noindex" />
  {/if}
</svelte:head>

{#snippet branchNode(node: (typeof branch)[number], depth: number)}
  <li>
    <a
      class="block truncate rounded px-2 py-1 hover:bg-surface"
      class:font-medium={node.slugId === data.page.slugId}
      href={node.id === rootId ? `/share/${data.key}` : `?p=${node.slugId}`}
      style="padding-left: {8 + depth * 12}px"
    >
      <span aria-hidden="true">{node.icon ?? '📄'}</span>
      {node.title ?? t('Untitled')}
    </a>
    {#if childrenOf(node.id).length > 0}
      <ul class="space-y-0.5">
        {#each childrenOf(node.id) as child (child.id)}
          {@render branchNode(child, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<div class="flex gap-6" class:justify-center={!hasBranch}>
  {#if hasBranch}
    <aside data-component="SharedTree" class="w-56 shrink-0">
      <form class="mb-3" onsubmit={search}>
        <input
          class="h-8 w-full rounded border border-border-input bg-surface px-2 text-sm text-text outline-none focus:border-accent"
          type="search"
          placeholder={t('Search')}
          bind:value={query}
        />
      </form>

      {#if failure}<p class="mb-2 text-xs text-danger">{failure}</p>{/if}

      {#if searching}
        <p class="text-xs text-text-muted">{t('Loading...')}</p>
      {:else if hits}
        <ul class="space-y-1 text-sm">
          {#each hits as hit (hit.id)}
            <li>
              <a class="block truncate rounded px-2 py-1 hover:bg-surface" href="?p={hit.slugId}">
                {hit.title ?? t('Untitled')}
              </a>
            </li>
          {:else}
            <li class="px-2 text-xs text-text-muted">{t('No pages match your search.')}</li>
          {/each}
        </ul>
        <button
          class="mt-2 px-2 text-xs text-text-muted hover:underline"
          type="button"
          onclick={() => {
            hits = null;
            query = '';
          }}
        >
          {t('Show all')}
        </button>
      {:else}
        <ul class="space-y-0.5 text-sm">
          {#each childrenOf(null) as node (node.id)}
            {@render branchNode(node, 0)}
          {/each}
        </ul>
      {/if}
    </aside>
  {/if}

  <article
    data-route="shared-page"
    class="min-w-0 flex-1 rounded border border-border bg-surface p-8"
  >
    <h1 class="text-3xl font-semibold">
      {#if data.page.icon}<span aria-hidden="true">{data.page.icon}</span>{/if}
      {data.page.title ?? t('Untitled')}
    </h1>
    <p class="mt-1 mb-6 text-sm text-text-muted">{t('Last updated')}: {when}</p>

    <PageBody content={data.page.content} />
  </article>
</div>

<p class="mt-6 text-center text-xs text-text-muted">
  {t('Anyone with the link can view this page')}
</p>
