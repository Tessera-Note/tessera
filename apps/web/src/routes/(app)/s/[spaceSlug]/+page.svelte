<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { IconBell, IconBellOff } from '@tabler/icons-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import PageListTabs from '$lib/components/page/PageListTabs.svelte';
  import SpaceStar from '$lib/components/space/SpaceStar.svelte';
  import { errorText } from '$lib/api/failure';
  import { createBase } from '$lib/features/base/services/bases';
  import { createPage } from '$lib/features/page/services/pages';
  import { unwatchSpace, watchSpace } from '$lib/features/space/services/spaces';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state(false);
  let failure = $state<string | null>(null);

  // Отметка приходит вместе с общим списком отмеченных: свой запрос ради
  // одного «да или нет» на каждое открытие пространства здесь лишний.
  const favorited = $derived(data.favoriteSpaces.some((one) => one.spaceId === data.space.id));

  /**
   * Подписка на пространство.
   *
   * Отдельно от подписки на страницу: та извещает об одной странице, эта — обо
   * всём, что в пространстве происходит.
   */
  let watching = $state(false);
  $effect(() => {
    watching = data.watching?.isWatching ?? false;
  });

  async function toggleWatch() {
    busy = true;
    failure = null;
    try {
      const status = watching ? await unwatchSpace(data.space.id) : await watchSpace(data.space.id);
      watching = status.isWatching;
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  async function addPage() {
    busy = true;
    failure = null;
    try {
      const created = await createPage({ spaceId: data.space.id });
      // Дерево в боковой панели читает список с сервера: без перечитывания
      // новая страница появится там только после перезагрузки.
      await invalidateAll();
      await goto(`/s/${data.space.slug}/p/${created.slugId}`);
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  /**
   * Завести базу сразу базой.
   *
   * Второй путь к тому же — завести страницу и превратить её подсказкой «начать
   * работу с». Он остаётся, но требует знать, что пустая страница это
   * заготовка базы; здесь база просится прямо.
   */
  async function addBase() {
    busy = true;
    failure = null;
    try {
      const created = await createBase({ spaceId: data.space.id });
      await invalidateAll();
      await goto(`/base/${created.id}`);
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{data.space.name ?? data.space.slug} · Tessera</title></svelte:head>

<section data-route="space">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="mb-1 text-2xl font-semibold">{data.space.name ?? data.space.slug}</h1>
      {#if data.space.description}
        <p class="text-text-muted">{data.space.description}</p>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <!-- Звезда отдельно от подписки: отметка — своя закладка, подписка —
           извещения о чужих правках. Так же они разведены на странице. -->
      <SpaceStar
        spaceId={data.space.id}
        name={data.space.name ?? data.space.slug}
        {favorited}
        onfailure={(message) => (failure = message)}
      />
      <IconButton
        icon={watching ? IconBell : IconBellOff}
        label={watching ? t('Unsubscribe') : t('Subscribe')}
        active={watching}
        disabled={busy}
        onclick={toggleWatch}
      />
      <a
        class="rounded border border-border bg-surface px-3 py-2 font-medium hover:bg-surface-muted"
        href="/s/{data.space.slug}/transfer"
      >
        {t('Import and export')}
      </a>
      <a
        class="rounded border border-border bg-surface px-3 py-2 font-medium hover:bg-surface-muted"
        href="/s/{data.space.slug}/trash"
      >
        {t('Trash')}
      </a>
      <Button variant="quiet" disabled={busy} onclick={addBase}>{t('New base')}</Button>
      <Button disabled={busy} onclick={addPage}>{busy ? t('Loading...') : t('New page')}</Button>
    </div>
  </div>

  {#if failure}<Notice message={failure} />{/if}

  <!--
    Те же три перечня, что на главной, но по этому пространству. В v1 экран
    пространства и есть эти вкладки (`features/space/components/space-home-tabs.tsx`);
    здесь стоял плоский список корневых страниц, по которому нельзя было
    понять, что в пространстве происходило.
  -->
  <div class="mt-6">
    <PageListTabs
      recent={data.recent}
      favorites={data.favorites}
      mine={data.mine}
      spaceId={data.space.id}
    />
  </div>
</section>
