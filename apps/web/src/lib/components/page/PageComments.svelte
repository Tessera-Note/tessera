<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import RichText from '$lib/components/page/RichText.svelte';
  import CommentEditor from '$lib/features/editor/CommentEditor.svelte';
  import { errorText } from '$lib/api/failure';
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
    pageId: string;
    comments: Comment[];
    userId?: string | null;
    /** Пространство страницы. Сужает поиск страниц при упоминании. */
    spaceId?: string | null;
  };
  const { pageId, comments, userId, spaceId = null }: Props = $props();

  const t = $derived(locale.t);

  let busy = $state(false);
  let failure = $state<string | null>(null);
  //: Какой комментарий правят. Правка на месте: отдельный экран ради одного
  //: абзаца увёл бы человека со страницы, которую он обсуждает.
  let editing = $state<string | null>(null);

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

<section data-component="PageComments" class="mt-12 border-t border-border pt-6">
  <h2 class="mb-4 text-lg font-medium">{t('Comments')}</h2>

  <ul class="mb-6 space-y-3">
    {#each comments as comment (comment.id)}
      <li class="card-soft rounded-md border border-border bg-surface-raised p-3">
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
          <span>{new Date(comment.createdAt).toLocaleString(locale.current)}</span>
          {#if comment.resolvedAt}
            <span>{t('Resolved')}</span>
          {/if}
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
          <button
            class="hover:underline"
            type="button"
            disabled={busy}
            onclick={() => act(() => deleteComment(comment.id))}
          >
            {t('Delete')}
          </button>
        </p>
      </li>
    {:else}
      <li class="text-sm text-text-muted">{t('No comments yet.')}</li>
    {/each}
  </ul>

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

  {#if failure}<Notice message={failure} />{/if}
</section>
