<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { ApiError } from '$lib/api/client';
  import { createPage } from '$lib/features/page/services/pages';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state(false);
  let failure = $state<string | null>(null);

  async function addPage() {
    busy = true;
    failure = null;
    try {
      const created = await createPage({ spaceId: data.space.id });
      // Дерево в боковой панели читает список с сервера: без перечитывания
      // новая страница появится там только после перезагрузки.
      await invalidateAll();
      await goto(`/s/${data.space.slug}/p/${created.slugId}`);
    } catch (error) {
      failure = error instanceof ApiError ? t(error.code, error.params) : t('Something went wrong');
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{data.space.name ?? data.space.slug} · Tessera</title></svelte:head>

<section data-route="space">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="mb-1 text-2xl font-semibold">{data.space.name ?? data.space.slug}</h1>
      {#if data.space.description}
        <p class="text-text-muted">{data.space.description}</p>
      {/if}
    </div>
    <Button disabled={busy} onclick={addPage}>{busy ? t('Loading...') : t('New page')}</Button>
  </div>

  {#if failure}<Notice message={failure} />{/if}

  <ul data-component="SpacePageList" class="mt-6 space-y-1">
    {#each data.pages as page (page.id)}
      <li>
        <a
          class="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface"
          href="/s/{data.space.slug}/p/{page.slugId}"
        >
          <span aria-hidden="true">{page.icon ?? '📄'}</span>
          <span class="truncate">{page.title ?? t('Untitled')}</span>
        </a>
      </li>
    {:else}
      <li class="px-2 text-text-muted">{t('No pages in this space')}</li>
    {/each}
  </ul>
</section>
