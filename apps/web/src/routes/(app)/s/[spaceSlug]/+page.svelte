<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
</script>

<svelte:head><title>{data.space.name ?? data.space.slug} · Tessera</title></svelte:head>

<section data-route="space">
  <h1 class="mb-1 text-2xl font-semibold">{data.space.name ?? data.space.slug}</h1>
  {#if data.space.description}
    <p class="mb-6 text-text-muted">{data.space.description}</p>
  {/if}

  <ul data-component="PageTree" class="mt-6 space-y-1">
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
