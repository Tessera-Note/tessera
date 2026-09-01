<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import PageBody from '$lib/components/page/PageBody.svelte';
  import PageComments from '$lib/components/page/PageComments.svelte';
  import PageSidePanel from '$lib/components/page/PageSidePanel.svelte';
  import { errorText } from '$lib/api/failure';
  import { addFavorite, removeFavorite } from '$lib/features/page/services/favorites';
  import { deletePage, updatePage } from '$lib/features/page/services/pages';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  const canEdit = $derived(data.page.canEdit !== false);

  let renaming = $state(false);
  let title = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  $effect(() => {
    title = data.page.title ?? '';
  });

  async function act(action: () => Promise<unknown>) {
    busy = true;
    failure = null;
    try {
      await action();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  const rename = (event: SubmitEvent) => {
    event.preventDefault();
    return act(async () => {
      await updatePage({ pageId: data.page.id, title });
      renaming = false;
      // Название видно и в дереве, и в хлебных крошках: перечитать надо всё.
      await invalidateAll();
    });
  };

  const toggleFavorite = () =>
    act(async () => {
      await (data.favorite ? removeFavorite(data.page.id) : addFavorite(data.page.id));
      await invalidateAll();
    });

  const remove = () =>
    act(async () => {
      // Удаление мягкое: страница уходит в корзину, откуда её возвращают.
      await deletePage(data.page.id);
      await invalidateAll();
      await goto(`/s/${data.space?.slug ?? ''}`);
    });
</script>

<svelte:head><title>{data.page.title ?? t('Untitled')} · Tessera</title></svelte:head>

<div class="mx-auto flex max-w-6xl gap-8">
  <article data-route="page" class="min-w-0 flex-1">
    {#if data.crumbs.length > 1}
      <nav data-component="Breadcrumbs" class="mb-4 flex flex-wrap gap-1 text-sm text-text-muted">
        {#each data.crumbs as crumb, index (crumb.id)}
          {#if index > 0}<span aria-hidden="true">/</span>{/if}
          <a class="hover:underline" href="/s/{data.space?.slug}/p/{crumb.slugId}">
            {crumb.title ?? t('Untitled')}
          </a>
        {/each}
      </nav>
    {/if}

    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      {#if renaming}
        <form class="flex flex-1 gap-2" onsubmit={rename}>
          <div class="flex-1"><TextInput bind:value={title} required /></div>
          <Button type="submit" disabled={busy}>{t('Save')}</Button>
          <Button variant="quiet" onclick={() => (renaming = false)}>{t('Cancel')}</Button>
        </form>
      {:else}
        <h1 class="min-w-64 flex-1 text-3xl font-semibold">
          {#if data.page.icon}<span class="mr-2" aria-hidden="true">{data.page.icon}</span>{/if}
          {data.page.title ?? t('Untitled')}
        </h1>

        <div class="flex shrink-0 gap-2">
          <Button variant="quiet" disabled={busy} onclick={toggleFavorite}>
            {data.favorite ? t('Remove from favorites') : t('Add to favorites')}
          </Button>
          {#if canEdit}
            <Button variant="quiet" onclick={() => (renaming = true)}>{t('Rename')}</Button>
            <Button variant="quiet" disabled={busy} onclick={remove}>{t('Delete')}</Button>
          {/if}
        </div>
      {/if}
    </div>

    {#if failure}<Notice message={failure} />{/if}

    <PageBody content={data.page.content} />

    <PageComments pageId={data.page.id} comments={data.comments} />
  </article>

  <PageSidePanel
    pageId={data.page.id}
    spaceId={data.page.spaceId}
    versions={data.versions}
    labels={data.labels}
    backlinks={data.backlinks}
    permission={data.permission}
    share={data.share}
    spaceSlug={data.space?.slug ?? ''}
  />
</div>
