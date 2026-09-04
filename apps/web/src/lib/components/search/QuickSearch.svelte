<script lang="ts">
  import { goto } from '$app/navigation';
  import { IconSearch } from '@tabler/icons-svelte';
  import { errorText } from '$lib/api/failure';
  import { highlightHtml } from '$lib/features/search/highlight';
  import { searchPages, type SearchHit } from '$lib/features/search/services/search';
  import type { Space } from '$lib/features/space/services/spaces';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    spaces: Space[];
    open: boolean;
    onclose: () => void;
  };
  const { spaces, open, onclose }: Props = $props();

  const t = $derived(locale.t);
  const slugs = $derived(new Map(spaces.map((one) => [one.id, one])));

  /**
   * Задержка перед запросом.
   *
   * Поиск идёт по мере набора, как в v1, и запрос на каждую букву означал бы
   * десяток обращений на одно слово. Триста миллисекунд — значение из v1
   * (`useDebouncedValue(query, 300)`).
   */
  const DELAY = 300;

  let query = $state('');
  let hits = $state<SearchHit[]>([]);
  let busy = $state(false);
  let asked = $state(false);
  let failure = $state<string | null>(null);
  let chosen = $state(0);
  let field: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (!open) return;
    // Поле получает ввод сразу: окно открывают, чтобы печатать.
    field?.focus();
  });

  $effect(() => {
    const text = query.trim();
    if (!text) {
      hits = [];
      asked = false;
      return;
    }

    const timer = setTimeout(async () => {
      busy = true;
      failure = null;
      try {
        hits = await searchPages(text);
        chosen = 0;
        asked = true;
      } catch (error) {
        failure = errorText(error, t);
      } finally {
        busy = false;
      }
    }, DELAY);
    return () => clearTimeout(timer);
  });

  function addressOf(hit: SearchHit): string {
    return `/s/${slugs.get(hit.spaceId)?.slug ?? ''}/p/${hit.slugId}`;
  }

  async function open_(hit: SearchHit) {
    onclose();
    await goto(addressOf(hit));
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
      return;
    }
    if (hits.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      chosen = (chosen + 1) % hits.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      chosen = (chosen - 1 + hits.length) % hits.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void open_(hits[chosen]);
    }
  }

  /** Уйти на полный поиск: там есть отбор по пространству и по вложениям. */
  async function everything() {
    const text = query.trim();
    onclose();
    await goto(text ? `/search?q=${encodeURIComponent(text)}` : '/search');
  }
</script>

<!--
  Быстрый поиск поверх экрана, как в v1 (`features/search/components/
  search-spotlight.tsx`). Там он открывается сочетанием откуда угодно, ищет по
  мере набора и водит по выдаче стрелками. Здесь поиск был отдельной страницей,
  на которую надо было сначала перейти, а потом ещё и нажать кнопку.
-->
{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    data-component="QuickSearch"
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
    onclick={(event) => event.target === event.currentTarget && onclose()}
  >
    <div
      class="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-label={t('Search')}
    >
      <div class="flex items-center gap-2 border-b border-border px-3">
        <IconSearch size={18} stroke={1.6} />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="h-12 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
          type="search"
          placeholder={t('Search...')}
          aria-label={t('Search')}
          bind:this={field}
          bind:value={query}
          {onkeydown}
        />
        {#if busy}<span class="text-xs text-text-muted">{t('Loading...')}</span>{/if}
      </div>

      {#if failure}
        <p class="px-3 py-2 text-sm text-danger" role="alert">{failure}</p>
      {/if}

      <ul class="max-h-96 overflow-y-auto py-1">
        {#each hits as hit, index (hit.id)}
          <li>
            <a
              class="block px-3 py-2 hover:bg-surface-hover"
              class:bg-surface-hover={index === chosen}
              href={addressOf(hit)}
              onclick={(event) => {
                event.preventDefault();
                void open_(hit);
              }}
            >
              <span class="flex items-baseline justify-between gap-3">
                <span class="truncate text-sm font-medium">{hit.title ?? t('Untitled')}</span>
                <!-- Пространство у строки: без него одинаковые названия из
                     разных пространств не различить. Так же в v1. -->
                <span class="shrink-0 text-xs text-text-muted">
                  {slugs.get(hit.spaceId)?.name ?? ''}
                </span>
              </span>
              {#if hit.highlight}
                <span class="mt-0.5 block truncate text-xs text-text-muted">
                  {@html highlightHtml(hit.highlight)}
                </span>
              {/if}
            </a>
          </li>
        {:else}
          {#if asked && !busy}
            <li class="px-3 py-2 text-sm text-text-muted">{t('No pages match your search.')}</li>
          {/if}
        {/each}
      </ul>

      <div class="border-t border-border px-3 py-2 text-right">
        <button
          class="text-xs text-text-muted hover:text-text hover:underline"
          type="button"
          onclick={everything}
        >
          {t('Advanced search')}
        </button>
      </div>
    </div>
  </div>
{/if}
