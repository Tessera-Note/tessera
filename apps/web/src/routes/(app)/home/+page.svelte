<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';
  import type { LayoutData } from '../$types';

  type Props = { data: LayoutData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
</script>

<svelte:head><title>{t('Home')} · Tessera</title></svelte:head>

<section data-route="home">
  <h1 class="mb-6 text-2xl font-semibold">{t('Home')}</h1>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each data.spaces as space (space.id)}
      <a
        data-component="SpaceCard"
        class="rounded-lg border border-border bg-surface-raised p-4 hover:border-text-muted"
        href="/s/{space.slug}"
      >
        <p class="font-medium">{space.name ?? space.slug}</p>
        {#if space.description}
          <p class="mt-1 line-clamp-2 text-sm text-text-muted">{space.description}</p>
        {/if}
      </a>
    {:else}
      <p class="text-text-muted">{t('No spaces found')}</p>
    {/each}
  </div>
</section>
