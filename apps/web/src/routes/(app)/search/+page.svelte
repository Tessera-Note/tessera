<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { highlightHtml } from '$lib/features/search/highlight';
  import { searchPages, type SearchHit } from '$lib/features/search/services/search';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { LayoutData } from '../$types';

  type Props = { data: LayoutData };
  const { data }: Props = $props();

  let query = $state('');
  let busy = $state(false);
  let asked = $state(false);
  let hits = $state<SearchHit[]>([]);
  let failure = $state<string | null>(null);

  const t = $derived(locale.t);
  // Короткое имя пространства нужно ссылке: адрес страницы собирается из него
  // и из короткого имени самой страницы.
  const slugs = $derived(new Map(data.spaces.map((one) => [one.id, one.slug])));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!query.trim()) return;

    busy = true;
    failure = null;
    try {
      hits = await searchPages(query);
      asked = true;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t('Search')} · Tessera</title></svelte:head>

<section data-route="search" class="mx-auto max-w-3xl">
  <h1 class="mb-6 text-2xl font-semibold">{t('Search')}</h1>

  <form class="mb-6 flex gap-2" onsubmit={submit}>
    <div class="flex-1">
      <TextInput bind:value={query} type="search" placeholder={t('Search')} />
    </div>
    <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Search')}</Button>
  </form>

  {#if failure}<Notice message={failure} />{/if}

  <ul data-component="SearchResults" class="space-y-2">
    {#each hits as hit (hit.id)}
      <li class="rounded border border-border bg-surface-raised p-3">
        <a class="font-medium hover:underline" href="/s/{slugs.get(hit.spaceId)}/p/{hit.slugId}">
          {hit.title ?? t('Untitled')}
        </a>
        {#if hit.highlight}
          <!--
            Подсветку ставит поиск в базе, а сам отрывок собран из содержимого
            страницы: перед вставкой он экранируется, и обратно возвращается
            только выделение совпадения.
          -->
          <p class="mt-1 text-sm text-text-muted">{@html highlightHtml(hit.highlight)}</p>
        {/if}
      </li>
    {:else}
      {#if asked && !busy}
        <li class="text-text-muted">{t('No pages match your search.')}</li>
      {/if}
    {/each}
  </ul>
</section>
