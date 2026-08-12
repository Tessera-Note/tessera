<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';
  import PageBody from '$lib/components/page/PageBody.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
</script>

<svelte:head><title>{data.page.title ?? t('Untitled')} · Tessera</title></svelte:head>

<article data-route="page" class="mx-auto max-w-3xl">
  <h1 class="mb-6 text-3xl font-semibold">
    {#if data.page.icon}<span class="mr-2" aria-hidden="true">{data.page.icon}</span>{/if}
    {data.page.title ?? t('Untitled')}
  </h1>

  <PageBody content={data.page.content} />
</article>
