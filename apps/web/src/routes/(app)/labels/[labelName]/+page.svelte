<script lang="ts">
  import { labelColor } from '$lib/features/label/colors';
  import { locale } from '$lib/stores/i18n.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  const color = $derived(labelColor(data.name, theme.current === 'dark' ? 'dark' : 'light'));
</script>

<svelte:head><title>{data.name} · Tessera</title></svelte:head>

<section data-route="label" class="mx-auto max-w-3xl">
  <p class="text-sm text-text-muted">{t('Labels')}</p>
  <h1 class="mb-6 mt-1 flex items-center gap-2 text-2xl font-semibold">
    <!-- Цвет метки тот же, что у значка на странице: без него перечень
         выглядит чужим экраном, а не продолжением метки. -->
    <span class="h-3 w-3 shrink-0 rounded-full" style="background: {color.dot}" aria-hidden="true"
    ></span>
    {data.name}
  </h1>

  <ul data-component="LabelledPages" class="space-y-2">
    {#each data.pages as page (page.id)}
      <li class="card-soft rounded-md border border-border bg-surface-raised p-5">
        <a class="block" href="/s/{page.spaceSlug}/p/{page.slugId}">
          <span class="block truncate font-medium">
            {#if page.icon}<span class="mr-1">{page.icon}</span>{/if}
            {page.title ?? t('Untitled')}
          </span>
          <span class="mt-1 block text-xs text-text-muted">
            {page.spaceName ?? page.spaceSlug}
          </span>
        </a>
      </li>
    {:else}
      <!-- Пусто и у незнакомой метки, и у метки без доступных страниц: разные
           ответы позволяли бы перебором узнать, какие метки заведены. -->
      <li class="text-sm text-text-muted">{t('No pages')}</li>
    {/each}
  </ul>
</section>
