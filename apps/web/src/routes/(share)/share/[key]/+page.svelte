<script lang="ts">
  import PageBody from '$lib/components/page/PageBody.svelte';
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
</script>

<svelte:head>
  <title>{data.page.title ?? t('Untitled')}</title>
  <!-- Отдаётся всем, у кого есть ссылка, но в поиске ему делать нечего:
       индексацией управляет отдельный признак ссылки, а не эта страница. -->
  <meta name="robots" content="noindex" />
</svelte:head>

<article data-route="shared-page" class="rounded border border-border bg-surface p-8">
  <h1 class="text-3xl font-semibold">{data.page.title ?? t('Untitled')}</h1>
  <p class="mt-1 mb-6 text-sm text-text-muted">{t('Last updated')}: {when}</p>

  <PageBody content={data.page.content} />
</article>

<p class="mt-6 text-center text-xs text-text-muted">
  {t('Anyone with the link can view this page')}
</p>
