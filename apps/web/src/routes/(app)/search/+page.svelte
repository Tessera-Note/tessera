<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { ApiError } from '$lib/api/client';
  import { errorText } from '$lib/api/failure';
  import { answerHtml } from '$lib/features/ai/answer';
  import { searchChats, type Chat } from '$lib/features/ai/services/chat';
  import { askWiki, type AnswerSource } from '$lib/features/search/services/answers';
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
  let chats = $state<Chat[]>([]);
  let failure = $state<string | null>(null);

  /**
   * Отбор, как в v1 (`features/search/components/search-spotlight-filters.tsx`):
   * пространство и вид содержимого. Без пространства выдача по всей вики
   * смешивает одинаковые названия из разных мест, а вложения ищет отдельный
   * маршрут — у них другой состав полей.
   */
  let space = $state(page.url.searchParams.get('space') ?? '');
  /** Виды выдачи. Значение из адреса, неизвестное считается страницами. */
  const KINDS = ['page', 'attachment', 'chat'];
  const kindFrom = (raw: string | null) => (raw && KINDS.includes(raw) ? raw : 'page');
  let kind = $state(kindFrom(page.url.searchParams.get('kind')));

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
    { value: 'attachment', label: t('Attachments') },
    { value: 'chat', label: t('Chats') }
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
        chats = [];
      } else if (want === 'chat') {
        // Разговор не принадлежит пространству: отбор по пространству к нему
        // не применяется, и передавать его сюда нечего.
        chats = await searchChats(text);
        hits = [];
        files = [];
      } else {
        hits = await searchPages(text, spaceId || null);
        files = [];
        chats = [];
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
    const wantedKind = kindFrom(page.url.searchParams.get('kind'));
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
    if (kind !== 'page') address.set('kind', kind);
    await goto(`/search?${address.toString()}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true
    });
  }

  /**
   * Ответ по вики словами.
   *
   * Режим «Ask» из v1: тот же запрос уходит модели, она читает найденное и
   * отвечает, указывая источники. Маршрут на сервере был, обращения к нему в
   * интерфейсе не было вовсе.
   */
  let asking = $state(false);
  let answer = $state('');
  let sources = $state<AnswerSource[]>([]);
  let answering = $state(false);
  let stopper: AbortController | null = null;

  async function ask() {
    const text = query.trim();
    if (!text || answering) return;

    answering = true;
    answer = '';
    sources = [];
    failure = null;
    stopper = new AbortController();
    try {
      for await (const frame of askWiki(text, space || null, stopper.signal)) {
        if ('sources' in frame) sources = frame.sources;
        else if ('content' in frame) answer += frame.content;
        else if ('error' in frame) {
          // Через общий разбор: в кадре приходит код, и показывать его нельзя.
          failure = errorText(new ApiError(500, frame.error, '', {}), t);
        }
      }
    } catch (error) {
      // Остановка это не отказ: человек сам прервал ответ.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        failure = errorText(error, t);
      }
    } finally {
      answering = false;
      stopper = null;
    }
  }

  function stopAsking() {
    stopper?.abort();
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
    <!--
      Спросить, а не искать: модель читает найденное и отвечает словами. В v1
      это тот же режим в том же окне (кнопка «Ask»).
    -->
    {#if answering}
      <Button variant="quiet" onclick={stopAsking}>{t('Cancel')}</Button>
    {:else}
      <Button variant="quiet" disabled={!query.trim()} onclick={ask}>{t('Ask')}</Button>
    {/if}
  </form>

  <div data-component="SearchFilters" class="mb-6 flex flex-wrap gap-2">
    <!-- Отбор по пространству к разговорам неприменим: они не в пространстве. -->
    {#if kind !== 'chat'}
      <Select
        bind:value={space}
        options={spaceOptions}
        label={t('Space')}
        compact
        onchange={() => submit()}
      />
    {/if}
    <Select
      bind:value={kind}
      options={kindOptions}
      label={t('Type')}
      compact
      onchange={() => submit()}
    />
  </div>

  {#if failure}<Notice message={failure} />{/if}

  {#if answering || answer || sources.length > 0}
    <section
      data-component="WikiAnswer"
      class="card-soft mb-6 rounded-md border border-border bg-surface-raised p-4"
    >
      {#if sources.length > 0}
        <p class="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          {t('Sources')}
        </p>
        <ul class="mb-3 space-y-1">
          {#each sources as source (source.pageId)}
            <li>
              <a class="text-sm hover:underline" href="/s/{source.spaceSlug}/p/{source.slugId}">
                {source.title ?? t('Untitled')}
              </a>
            </li>
          {/each}
        </ul>
      {/if}

      {#if answer}
        <!--
          Ответ — разметка Markdown, тот же путь, что в разговоре: показ
          обычным текстом выводил бы ссылки и списки как есть.
        -->
        <div class="chat-answer text-sm">{@html answerHtml(answer)}</div>
      {:else if answering}
        <p class="text-sm text-text-muted">{t('Thinking')}</p>
      {/if}
    </section>
  {/if}

  <ul data-component="SearchResults" class="space-y-2">
    {#if kind === 'chat'}
      {#each chats as chat (chat.id)}
        <li class="card-soft rounded-md border border-border bg-surface-raised p-3">
          <a class="font-medium hover:underline" href="/ai/{chat.id}">
            {chat.title ?? t('Untitled chat')}
          </a>
        </li>
      {:else}
        {#if asked && !busy}
          <li class="text-text-muted">{t('No chats found')}</li>
        {/if}
      {/each}
    {:else if kind === 'attachment'}
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
