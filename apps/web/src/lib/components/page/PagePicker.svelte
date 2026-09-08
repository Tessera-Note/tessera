<script lang="ts">
  import { errorText } from '$lib/api/failure';
  import { searchPages, type SearchHit } from '$lib/features/search/services/search';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** В каком пространстве искать. Смена пространства сбрасывает выбор. */
    spaceId: string;
    /** Выбранная страница. Пусто — корень пространства. */
    value: { id: string; title: string | null } | null;
    onpick: (page: { id: string; title: string | null } | null) => void;
  };
  const { spaceId, value, onpick }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Задержка перед запросом.
   *
   * Поиск идёт по мере набора, и запрос на каждую букву означал бы десяток
   * обращений на одно слово. Значение то же, что у быстрого поиска.
   */
  const DELAY = 300;

  let query = $state('');
  let hits = $state<SearchHit[]>([]);
  let busy = $state(false);
  let asked = $state(false);
  let failure = $state<string | null>(null);

  $effect(() => {
    // Смена пространства обнуляет набранное и найденное: страницы прежнего
    // пространства родителями здесь быть не могут.
    void spaceId;
    query = '';
    hits = [];
    asked = false;
    failure = null;
  });

  $effect(() => {
    const text = query.trim();
    const where = spaceId;
    if (!text) {
      hits = [];
      asked = false;
      return;
    }

    const timer = setTimeout(async () => {
      busy = true;
      failure = null;
      try {
        // Поиск сужен пространством: страница-родитель обязана лежать там же,
        // куда заводится новая, и находки из соседнего только мешают.
        hits = await searchPages(text, where);
        asked = true;
      } catch (error) {
        failure = errorText(error, t);
      } finally {
        busy = false;
      }
    }, DELAY);

    return () => clearTimeout(timer);
  });
</script>

<!--
  Выбор родительской страницы. Пустой выбор означает корень пространства — это
  и есть обычный случай, поэтому он не требует ни нажатия, ни отдельной строки
  в перечне.
-->
<div data-component="PagePicker">
  <span class="mb-1 block text-sm text-text-muted">{t('Parent page')}</span>

  {#if value}
    <div class="flex items-center gap-2">
      <span
        class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded border border-border bg-surface px-2 py-1 text-sm"
      >
        {value.title ?? t('Untitled')}
      </span>
      <button
        class="rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
        type="button"
        onclick={() => onpick(null)}
      >
        {t('Clear')}
      </button>
    </div>
  {:else}
    <input
      class="h-9 w-full rounded border border-border-input bg-surface px-2.5 text-sm text-text outline-none focus:border-accent"
      type="search"
      placeholder={t('Search by title')}
      bind:value={query}
    />
    <p class="mt-1 text-xs text-text-muted">{t('At the root of the space')}</p>
  {/if}

  {#if failure}<p class="mt-1 text-xs text-danger" role="alert">{failure}</p>{/if}

  {#if !value && query.trim()}
    {#if busy}
      <p class="mt-1 text-xs text-text-muted">{t('Loading...')}</p>
    {:else if asked && hits.length === 0}
      <p class="mt-1 text-xs text-text-muted">{t('No results found')}</p>
    {:else if hits.length > 0}
      <ul class="mt-1 max-h-40 overflow-y-auto rounded border border-border bg-surface text-sm">
        {#each hits as hit (hit.id)}
          <li>
            <button
              class="block w-full overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1 text-left hover:bg-surface-hover"
              type="button"
              onclick={() => onpick({ id: hit.id, title: hit.title })}
            >
              {hit.title ?? t('Untitled')}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
