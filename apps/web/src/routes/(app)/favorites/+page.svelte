<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import { removeFavorite } from '$lib/features/page/services/favorites';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  async function drop(pageId: string) {
    busy = pageId;
    failure = null;
    try {
      await removeFavorite(pageId);
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }
</script>

<svelte:head><title>{t('Favorites')} · Tessera</title></svelte:head>

<section data-route="favorites" class="mx-auto max-w-3xl">
  <h1 class="mb-6 text-2xl font-semibold">{t('Favorites')}</h1>

  {#if failure}<Notice message={failure} />{/if}

  <ul data-component="FavoriteList" class="space-y-2">
    {#each data.favorites as favorite (favorite.id)}
      <li
        class="flex items-center justify-between gap-4 card-soft rounded-md border border-border bg-surface-raised p-5"
      >
        <div class="min-w-0">
          <a class="block truncate font-medium" href="/s/{favorite.spaceSlug}/p/{favorite.slugId}">
            {#if favorite.icon}<span class="mr-1">{favorite.icon}</span>{/if}
            {favorite.title ?? t('Untitled')}
          </a>
          <!-- Пространство ссылкой, а не подписью: в v1 это значок, по
               которому переходят к самому пространству. -->
          <a
            class="mt-0.5 inline-block truncate rounded bg-surface-muted px-1.5 text-xs text-text-muted hover:text-text"
            href="/s/{favorite.spaceSlug}"
          >
            {favorite.spaceName ?? favorite.spaceSlug}
          </a>
        </div>
        <Button
          variant="quiet"
          disabled={busy === favorite.pageId}
          onclick={() => drop(favorite.pageId)}
        >
          {t('Remove from favorites')}
        </Button>
      </li>
    {:else}
      <li class="text-sm text-text-muted">{t('No favorites yet')}</li>
    {/each}
  </ul>
</section>
