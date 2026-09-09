<script lang="ts">
  import DocumentToc from '$lib/components/page/DocumentToc.svelte';
  import PageBody from '$lib/components/page/PageBody.svelte';
  import { headings } from '$lib/features/page/document';
  import { errorText } from '$lib/api/failure';
  import { searchShared, type SharedHit } from '$lib/features/share/services/share';
  import { shareWidth } from '$lib/features/share/width.svelte';
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

  /**
   * Оглавление страницы.
   *
   * На широком экране — столбцом справа, как в v1 (`share-shell.tsx`): длинную
   * страницу читают по разделам, и сложенный блок для этого надо каждый раз
   * разворачивать. На узком экране столбца нет: третий столбец на телефоне не
   * помещается, и там оглавление остаётся складным блоком над текстом.
   */
  const chapters = $derived(headings(data.page.content));
  /** Лист во всю ширину. Выбор читателя, помнится в его браузере. */
  const wide = $derived(shareWidth.wide);

  let showToc = $state(false);
  let article = $state<HTMLElement | null>(null);

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

<!-- На узком экране ветвь встаёт над текстом, а не рядом: столбец в 224
     пикселя из 390 не оставляет места самой странице. -->
<div class="flex flex-col gap-6 sm:flex-row" class:justify-center={!hasBranch && !wide}>
  <!--
    Столбец с поиском стоит и у ссылки на одну страницу. Раньше он появлялся
    только вместе с ветвью, и посторонний, открывший такую ссылку, искать по
    ней не мог вовсе, хотя поиск по ключу работает и для неё.
  -->
  <aside data-component="SharedTree" class="w-full shrink-0 sm:w-56">
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
    {:else if hasBranch}
      <ul class="space-y-0.5 text-sm">
        {#each childrenOf(null) as node (node.id)}
          {@render branchNode(node, 0)}
        {/each}
      </ul>
    {/if}
  </aside>

  <article
    bind:this={article}
    data-route="shared-page"
    class="min-w-0 flex-1 rounded border border-border bg-surface p-8"
  >
    <h1 class="text-3xl font-semibold">
      {#if data.page.icon}<span aria-hidden="true">{data.page.icon}</span>{/if}
      {data.page.title ?? t('Untitled')}
    </h1>
    <p class="mt-1 mb-6 text-sm text-text-muted">{t('Last updated')}: {when}</p>

    {#if chapters.length > 0}
      <!-- Складной блок только там, где нет столбца: на широком экране он
           повторял бы оглавление, стоящее справа. -->
      <div class="mb-6 rounded-md border border-border bg-surface-muted p-3 lg:hidden">
        <button
          class="text-sm font-medium text-text-muted hover:text-text"
          type="button"
          aria-expanded={showToc}
          onclick={() => (showToc = !showToc)}
        >
          {t('Table of contents')}
        </button>
        {#if showToc}
          <div class="mt-2">
            <DocumentToc content={data.page.content} body={() => article} />
          </div>
        {/if}
      </div>
    {/if}

    <PageBody content={data.page.content} />
  </article>

  {#if chapters.length > 0}
    <aside
      data-component="SharedToc"
      class="hidden w-56 shrink-0 lg:block"
      aria-label={t('Table of contents')}
    >
      <!-- Закреплено при прокрутке: оглавление нужно как раз тогда, когда
           текст уехал вверх. -->
      <div class="sticky top-6 max-h-[80vh] overflow-y-auto">
        <p class="mb-2 text-sm font-medium">{t('Table of contents')}</p>
        <DocumentToc content={data.page.content} body={() => article} />
      </div>
    </aside>
  {/if}
</div>

<p class="mt-6 text-center text-xs text-text-muted">
  {t('Anyone with the link can view this page')}
</p>
