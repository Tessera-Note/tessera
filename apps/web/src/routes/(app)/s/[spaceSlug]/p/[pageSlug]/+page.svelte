<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import PageBody from '$lib/components/page/PageBody.svelte';
  import PageComments from '$lib/components/page/PageComments.svelte';
  import PageSidePanel from '$lib/components/page/PageSidePanel.svelte';
  import { ApiError } from '$lib/api/client';
  import { errorText } from '$lib/api/failure';
  import { addFavorite, removeFavorite } from '$lib/features/page/services/favorites';
  import { deletePage, updatePage } from '$lib/features/page/services/pages';
  import { createTemplate } from '$lib/features/template/services/templates';
  import { downloadPdf, exportPagePdf, listFileTasks } from '$lib/features/page/services/pdf';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  const canEdit = $derived(data.page.canEdit !== false);

  let renaming = $state(false);
  let title = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  $effect(() => {
    title = data.page.title ?? '';
  });

  async function act(action: () => Promise<unknown>) {
    busy = true;
    failure = null;
    try {
      await action();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  const rename = (event: SubmitEvent) => {
    event.preventDefault();
    return act(async () => {
      await updatePage({ pageId: data.page.id, title });
      renaming = false;
      // Название видно и в дереве, и в хлебных крошках: перечитать надо всё.
      await invalidateAll();
    });
  };

  const toggleFavorite = () =>
    act(async () => {
      await (data.favorite ? removeFavorite(data.page.id) : addFavorite(data.page.id));
      await invalidateAll();
    });

  let savedTemplate = $state(false);
  /** Задание печати: пока оно идёт, человеку сообщается, что оно идёт. */
  let printing = $state(false);

  /**
   * Отправить страницу на печать.
   *
   * Печатает браузер на стороне сервера, и это занимает время: ответ приходит
   * заданием, а не файлом. Готовый документ забирается по его идентификатору.
   */
  const exportPdf = () =>
    act(async () => {
      printing = true;
      try {
        const task = await exportPagePdf({ pageId: data.page.id });
        await waitForPdf(task.fileTaskId);
      } finally {
        printing = false;
      }
    });

  async function waitForPdf(fileTaskId: string): Promise<void> {
    // Опрос, а не ожидание одного ответа: печать ветви занимает десятки секунд,
    // и держать запрос всё это время нельзя.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((done) => setTimeout(done, 1000));
      const tasks = await listFileTasks();
      const task = tasks.items.find((one) => one.id === fileTaskId);
      if (!task) continue;
      if (task.status === 'failed') {
        throw new ApiError(400, 'error.pdf_export.export_not_found', task.errorMessage ?? '', {});
      }
      if (task.status === 'success') {
        await downloadPdf(fileTaskId, task.fileName);
        return;
      }
    }
    throw new ApiError(408, 'error.pdf_export.export_is_not_ready_yet', '', {});
  }

  /**
   * Сохранить страницу шаблоном.
   *
   * Область — пространство страницы, а не рабочее пространство: страница
   * писалась под своё пространство, и предлагать её всем по умолчанию значит
   * навязывать чужой порядок.
   */
  const saveAsTemplate = () =>
    act(async () => {
      savedTemplate = false;
      await createTemplate({
        title: data.page.title ?? t('Untitled'),
        icon: data.page.icon ?? undefined,
        content: data.page.content,
        spaceId: data.page.spaceId
      });
      savedTemplate = true;
    });

  const remove = () =>
    act(async () => {
      // Удаление мягкое: страница уходит в корзину, откуда её возвращают.
      await deletePage(data.page.id);
      await invalidateAll();
      await goto(`/s/${data.space?.slug ?? ''}`);
    });
</script>

<svelte:head><title>{data.page.title ?? t('Untitled')} · Tessera</title></svelte:head>

<div class="mr-aside">
  <article data-route="page" class="mx-auto max-w-3xl">
    {#if data.crumbs.length > 1}
      <nav data-component="Breadcrumbs" class="mb-4 flex flex-wrap gap-1 text-sm text-text-muted">
        {#each data.crumbs as crumb, index (crumb.id)}
          {#if index > 0}<span aria-hidden="true">/</span>{/if}
          <a class="hover:underline" href="/s/{data.space?.slug}/p/{crumb.slugId}">
            {crumb.title ?? t('Untitled')}
          </a>
        {/each}
      </nav>
    {/if}

    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      {#if renaming}
        <form class="flex flex-1 gap-2" onsubmit={rename}>
          <div class="flex-1"><TextInput bind:value={title} required /></div>
          <Button type="submit" disabled={busy}>{t('Save')}</Button>
          <Button variant="quiet" onclick={() => (renaming = false)}>{t('Cancel')}</Button>
        </form>
      {:else}
        <h1 class="min-w-64 flex-1 text-3xl font-semibold">
          {#if data.page.icon}<span class="mr-2" aria-hidden="true">{data.page.icon}</span>{/if}
          {data.page.title ?? t('Untitled')}
        </h1>

        <div class="flex shrink-0 gap-2">
          <Button variant="quiet" disabled={busy} onclick={toggleFavorite}>
            {data.favorite ? t('Remove from favorites') : t('Add to favorites')}
          </Button>
          {#if canEdit}
            <Button variant="quiet" onclick={() => (renaming = true)}>{t('Rename')}</Button>
            <Button variant="quiet" disabled={busy} onclick={saveAsTemplate}>
              {t('New template')}
            </Button>
            <Button variant="quiet" disabled={busy || printing} onclick={exportPdf}>
              {printing ? t('Loading...') : t('PDF')}
            </Button>
            <Button variant="quiet" disabled={busy} onclick={remove}>{t('Delete')}</Button>
          {/if}
        </div>
      {/if}
    </div>

    {#if failure}<Notice message={failure} />{/if}
    {#if savedTemplate}<Notice tone="info" message={t('Template created successfully')} />{/if}

    <PageBody content={data.page.content} />

    <PageComments pageId={data.page.id} comments={data.comments} />
  </article>

  <PageSidePanel
    pageId={data.page.id}
    spaceId={data.page.spaceId}
    versions={data.versions}
    labels={data.labels}
    backlinks={data.backlinks}
    permission={data.permission}
    verification={data.verification}
    share={data.share}
    spaceSlug={data.space?.slug ?? ''}
  />
</div>
