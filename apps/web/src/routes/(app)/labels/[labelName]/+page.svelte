<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import { labelColor } from '$lib/features/label/colors';
  import { pagesWithLabel, type LabelledPage } from '$lib/features/page/services/labels';
  import { locale } from '$lib/stores/i18n.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  const color = $derived(labelColor(data.name, theme.current === 'dark' ? 'dark' : 'light'));

  /**
   * Догруженные страницы перечня.
   *
   * Выдача постраничная, и страница бывает короче запрошенной: права
   * выбрасывают строки уже после выборки. Поэтому конец перечня показывает
   * пустой курсор, а не короткая страница.
   */
  let more = $state<LabelledPage[]>([]);
  let cursor = $state<string | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  const pages = $derived([...data.pages, ...more]);

  $effect(() => {
    // Догруженное относилось к прежней метке: экран один на все метки, и
    // переход по ссылке компонент не пересоздаёт.
    void data.name;
    more = [];
    cursor = data.nextCursor;
  });

  async function loadMore() {
    if (!cursor) return;
    busy = true;
    failure = null;
    try {
      const next = await pagesWithLabel({ name: data.name, cursor });
      more = [...more, ...next.items];
      cursor = next.meta.nextCursor;
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
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
    {#each pages as page (page.id)}
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

  {#if failure}<div class="mt-4"><Notice message={failure} /></div>{/if}

  {#if cursor}
    <!-- Без продолжения перечень обрывался бы на потолке выдачи, и молча. -->
    <div class="mt-4">
      <Button variant="quiet" disabled={busy} onclick={loadMore}>
        {busy ? t('Loading...') : t('Load more')}
      </Button>
    </div>
  {/if}
</section>
