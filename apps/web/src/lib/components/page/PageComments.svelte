<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import RichText from '$lib/components/page/RichText.svelte';
  import CommentEditor from '$lib/features/editor/CommentEditor.svelte';
  import { errorText } from '$lib/api/failure';
  import { copyText } from '$lib/features/clipboard';
  import {
    createComment,
    deleteComment,
    resolveComment,
    updateComment,
    type Comment
  } from '$lib/features/page/services/comments';
  import { onRealtime } from '$lib/features/realtime/socket';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    /** Показ внутри панели: без заголовка и отбивки. */
    bare?: boolean;
    pageId: string;
    comments: Comment[];
    userId?: string | null;
    /** Пространство страницы. Сужает поиск страниц при упоминании. */
    spaceId?: string | null;
    /**
     * На какую реплику навести взгляд.
     *
     * Приходит из адреса: по ссылке на реплику страница открывается с ней
     * подсвеченной. Без этого ссылка приводила на страницу целиком, и ту самую
     * реплику приходилось искать глазами.
     */
    highlight?: string | null;
    /**
     * Вправе ли смотрящий писать в обсуждение.
     *
     * Правило на сервере: пишущий — всегда, читатель — только если это
     * разрешено настройкой пространства. Поле, отвечающее отказом после
     * набранного текста, хуже отсутствующего.
     */
    canComment?: boolean;
  };
  const {
    pageId,
    comments,
    userId,
    spaceId = null,
    canComment = true,
    bare = false,
    highlight = null
  }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state(false);
  let failure = $state<string | null>(null);
  /** Какая ссылка только что скопирована. Показывается вместо подписи. */
  let copied = $state<string | null>(null);

  /**
   * Ссылка на отдельную реплику.
   *
   * Через свой маршрут, а не через адрес страницы с доводом: тот, кто её
   * копирует, знает идентификатор реплики, но не короткое имя страницы, а
   * маршрут узнаёт страницу сам.
   */
  async function copyLink(commentId: string) {
    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    copied = (await copyText(`${origin}/c/${commentId}`)) ? commentId : null;
    if (copied) setTimeout(() => (copied = null), 2000);
  }

  /**
   * Подсвеченная реплика подводится под взгляд.
   *
   * Обсуждение бывает длинным, и реплика по ссылке оказывается за краем
   * экрана: подсветка без прокрутки не помогает найти её.
   */
  let host = $state<HTMLElement | null>(null);
  $effect(() => {
    const wanted = highlight;
    if (!wanted || !host) return;
    host.querySelector(`[data-comment="${wanted}"]`)?.scrollIntoView({ block: 'center' });
  });
  //: Какой комментарий правят. Правка на месте: отдельный экран ради одного
  //: абзаца увёл бы человека со страницы, которую он обсуждает.
  let editing = $state<string | null>(null);
  //: О каком комментарии задан вопрос об удалении. Удаление необратимо, а
  //: кнопка стоит в ряду с безобидными «Решено» и «Ссылка».
  let asking = $state<string | null>(null);

  /** Поле нового комментария и поле правки. Тело читается из них вызовом. */
  let composer = $state<CommentEditor | null>(null);
  let draft = $state<CommentEditor | null>(null);

  async function act(action: () => Promise<unknown>) {
    busy = true;
    failure = null;
    try {
      await action();
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  function save(id: string) {
    const content = draft?.content();
    if (!content || draft?.isEmpty()) return;
    return act(async () => {
      await updateComment(id, content);
      editing = null;
    });
  }

  /**
   * Обсуждение обновляется от канала событий.
   *
   * Комментарий соседа появляется сразу, а не после перезагрузки: люди
   * обсуждают страницу одновременно, и запаздывающая лента читается как
   * потерянное сообщение.
   */
  $effect(() => {
    return onRealtime((event) => {
      const kinds = ['commentCreated', 'commentUpdated', 'commentDeleted', 'commentResolved'];
      if (!kinds.includes(String(event.operation ?? ''))) return;
      if (event.pageId && event.pageId !== pageId) return;
      void invalidateAll();
    });
  });

  async function submit() {
    const content = composer?.content();
    if (!content || composer?.isEmpty()) return;

    busy = true;
    failure = null;
    try {
      await createComment({ pageId, content });
      composer?.clear();
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<!--
  Внутри панели заголовок и отбивка не нужны: вкладка уже названа, а линия
  сверху делит панель пополам без повода. `bare` включается панелью.
-->
<section
  bind:this={host}
  data-component="PageComments"
  class={bare ? '' : 'mt-12 border-t border-border pt-6'}
>
  {#if !bare}
    <h2 class="mb-4 text-lg font-medium">{t('Comments')}</h2>
  {/if}

  <ul class="mb-6 space-y-3">
    {#each comments as comment (comment.id)}
      <li
        class="card-soft rounded-md border bg-surface-raised p-3"
        class:border-border={highlight !== comment.id}
        class:border-accent={highlight === comment.id}
        data-comment={comment.id}
      >
        <!-- Кто написал. Без этого в панели стояла одна дата, и обсуждение
             читалось как список ничьих реплик. Так же в v1. -->
        <div class="mb-2 flex items-center gap-2">
          <Avatar src={comment.creatorAvatarUrl} name={comment.creatorName} size={24} />
          <span class="text-sm font-medium">
            {comment.creatorName ?? t('Unknown user')}
          </span>
          <span class="text-xs text-text-muted">
            {new Date(comment.createdAt).toLocaleString(locale.current)}
          </span>
          {#if comment.resolvedAt}
            <span class="text-xs text-text-muted">{t('Resolved')}</span>
          {/if}
        </div>

        {#if comment.selection}
          <!-- Процитированный кусок страницы: без него обсуждение выделения
               читается как обсуждение страницы целиком. -->
          <p class="mb-2 line-clamp-3 border-l-2 border-accent pl-2 text-xs text-text-muted">
            {comment.selection}
          </p>
        {/if}

        {#if editing === comment.id}
          <div class="flex flex-col gap-2">
            <CommentEditor
              bind:this={draft}
              initial={comment.content}
              {spaceId}
              {userId}
              fail={(error) => (failure = errorText(error, t))}
              onsubmit={() => save(comment.id)}
            />
            <span class="flex gap-2">
              <Button disabled={busy} onclick={() => save(comment.id)}>{t('Save')}</Button>
              <Button variant="quiet" onclick={() => (editing = null)}>{t('Cancel')}</Button>
            </span>
          </div>
        {:else}
          <div class:text-text-muted={comment.resolvedAt}>
            <RichText content={comment.content} />
          </div>
        {/if}

        <p class="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-muted">
          <button
            class="hover:underline"
            type="button"
            disabled={busy}
            onclick={() => act(() => resolveComment(comment.id, !comment.resolvedAt))}
          >
            {comment.resolvedAt ? t('Unresolve comment') : t('Resolve comment')}
          </button>
          {#if userId && comment.creatorId === userId}
            <!-- Править можно только своё: сервер отвергает чужое, и кнопка,
                 которая всегда отказывает, хуже её отсутствия. -->
            <button
              class="hover:underline"
              type="button"
              disabled={busy}
              onclick={() => (editing = comment.id)}
            >
              {t('Edit')}
            </button>
          {/if}
          {#if asking === comment.id}
            <span class="flex flex-wrap items-center gap-2 text-danger">
              {t('Are you sure you want to delete this comment?')}
              <button
                class="hover:underline"
                type="button"
                disabled={busy}
                onclick={() => {
                  asking = null;
                  return act(() => deleteComment(comment.id));
                }}
              >
                {t('Delete')}
              </button>
              <button
                class="text-text-muted hover:underline"
                type="button"
                onclick={() => (asking = null)}
              >
                {t('Cancel')}
              </button>
            </span>
          {:else}
            <button
              class="hover:underline"
              type="button"
              disabled={busy}
              onclick={() => (asking = comment.id)}
            >
              {t('Delete')}
            </button>
          {/if}
          <!-- Ссылка на реплику: без неё сослаться можно было только на
               страницу целиком. -->
          <button class="hover:underline" type="button" onclick={() => copyLink(comment.id)}>
            {copied === comment.id ? t('Copied') : t('Copy link')}
          </button>
        </p>
      </li>
    {:else}
      <li class="text-sm text-text-muted">{t('No comments yet.')}</li>
    {/each}
  </ul>

  {#if canComment}
    <!--
      Поле привязано к странице: маршрут один на все страницы, и без ключа
      набранный, но не отправленный черновик уезжал вместе с человеком на
      соседнюю страницу и отправлялся уже туда.
    -->
    {#key pageId}
      <div class="flex flex-col gap-2">
        <CommentEditor
          bind:this={composer}
          {spaceId}
          {userId}
          fail={(error) => (failure = errorText(error, t))}
          onsubmit={submit}
        />
        <span>
          <Button disabled={busy} onclick={submit}>
            {busy ? t('Loading...') : t('Add comment')}
          </Button>
        </span>
      </div>
    {/key}
  {/if}

  {#if failure}<Notice message={failure} />{/if}
</section>
