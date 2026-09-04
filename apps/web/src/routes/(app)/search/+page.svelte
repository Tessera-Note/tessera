<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import { highlightHtml } from '$lib/features/search/highlight';
  import {
    searchAttachments,
    searchPages,
    type AttachmentHit,
    type SearchHit
  } from '$lib/features/search/services/search';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { LayoutData } from '../$types';

  type Props = { data: LayoutData };
  const { data }: Props = $props();

  let query = $state(page.url.searchParams.get('q') ?? '');
  let busy = $state(false);
  let asked = $state(false);
  let hits = $state<SearchHit[]>([]);
  let files = $state<AttachmentHit[]>([]);
  let failure = $state<string | null>(null);

  /**
   * Отбор, как в v1 (`features/search/components/search-spotlight-filters.tsx`):
   * пространство и вид содержимого. Без пространства выдача по всей вики
   * смешивает одинаковые названия из разных мест, а вложения ищет отдельный
   * маршрут — у них другой состав полей.
   */
  let space = $state(page.url.searchParams.get('space') ?? '');
  let kind = $state(page.url.searchParams.get('kind') === 'attachment' ? 'attachment' : 'page');

  const t = $derived(locale.t);
  // Короткое имя пространства нужно ссылке: адрес страницы собирается из него
  // и из короткого имени самой страницы.
  const spaces = $derived(new Map(data.spaces.map((one) => [one.id, one])));

  const spaceOptions = $derived([
    { value: '', label: t('All spaces') },
    ...data.spaces.map((one) => ({ value: one.id, label: one.name ?? one.slug }))
  ]);

  const kindOptions = $derived([
    { value: 'page', label: t('Pages') },
    { value: 'attachment', label: t('Attachments') }
  ]);

  /**
   * Запрос живёт в адресе, а не только в поле.
   *
   * Иначе адрес обещает больше, чем делает: он показывает `?q=…`, а открытая по
   * нему страница пуста — и это видно только тому, кто такой ссылкой
   * поделился или просто обновил вкладку.
   */
  async function run(text: string, spaceId: string, want: string): Promise<void> {
    busy = true;
    failure = null;
    try {
      if (want === 'attachment') {
        files = await searchAttachments(text, spaceId || null);
        hits = [];
      } else {
        hits = await searchPages(text, spaceId || null);
        files = [];
      }
      asked = true;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    // Читаются ровно доводы из адреса. Всё остальное этот обработчик только
    // пишет: эффект, прочитавший то, что сам записал, подписывается на
    // собственную запись, и Svelte снимает ветвь целиком.
    const wanted = page.url.searchParams.get('q') ?? '';
    const wantedSpace = page.url.searchParams.get('space') ?? '';
    const wantedKind = page.url.searchParams.get('kind') === 'attachment' ? 'attachment' : 'page';
    if (!wanted.trim()) return;
    untrack(() => {
      query = wanted;
      space = wantedSpace;
      kind = wantedKind;
    });
    void run(wanted, wantedSpace, wantedKind);
  });

  /** Отправка только правит адрес. Сам поиск идёт от адреса, одним путём. */
  async function submit(event?: SubmitEvent) {
    event?.preventDefault();
    const text = query.trim();
    if (!text) return;
    const address = new URLSearchParams({ q: text });
    if (space) address.set('space', space);
    if (kind === 'attachment') address.set('kind', kind);
    await goto(`/search?${address.toString()}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true
    });
  }

  function addressOf(hit: SearchHit): string {
    return `/s/${spaces.get(hit.spaceId)?.slug ?? ''}/p/${hit.slugId}`;
  }
</script>

<svelte:head><title>{t('Search')} · Tessera</title></svelte:head>

<section data-route="search" class="mx-auto max-w-3xl">
  <h1 class="mb-6 text-2xl font-semibold">{t('Search')}</h1>

  <form class="mb-4 flex gap-2" onsubmit={submit}>
    <div class="flex-1">
      <TextInput bind:value={query} type="search" placeholder={t('Search')} />
    </div>
    <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Search')}</Button>
  </form>

  <div data-component="SearchFilters" class="mb-6 flex flex-wrap gap-2">
    <Select
      bind:value={space}
      options={spaceOptions}
      label={t('Space')}
      compact
      onchange={() => submit()}
    />
    <Select
      bind:value={kind}
      options={kindOptions}
      label={t('Type')}
      compact
      onchange={() => submit()}
    />
  </div>

  {#if failure}<Notice message={failure} />{/if}

  <ul data-component="SearchResults" class="space-y-2">
    {#if kind === 'attachment'}
      {#each files as file (file.id)}
        <li class="card-soft rounded-md border border-border bg-surface-raised p-3">
          <span class="flex items-baseline justify-between gap-3">
            <a
              class="truncate font-medium hover:underline"
              href="/api/files/{file.id}/{file.fileName}"
            >
              {file.fileName}
            </a>
            <span class="shrink-0 text-xs text-text-muted">
              {spaces.get(file.spaceId)?.name ?? ''}
            </span>
          </span>
          {#if file.highlight}
            <p class="mt-1 text-sm text-text-muted">{@html highlightHtml(file.highlight)}</p>
          {/if}
        </li>
      {:else}
        {#if asked && !busy}
          <li class="text-text-muted">{t('No attachments match your search.')}</li>
        {/if}
      {/each}
    {:else}
      {#each hits as hit (hit.id)}
        <li class="card-soft rounded-md border border-border bg-surface-raised p-3">
          <span class="flex items-baseline justify-between gap-3">
            <a class="truncate font-medium hover:underline" href={addressOf(hit)}>
              {hit.title ?? t('Untitled')}
            </a>
            <!-- Пространство у строки: без него одинаковые названия из разных
                 пространств не различить. Так же в v1. -->
            <span class="shrink-0 text-xs text-text-muted">
              {spaces.get(hit.spaceId)?.name ?? ''}
            </span>
          </span>
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
    {/if}
  </ul>
</section>
