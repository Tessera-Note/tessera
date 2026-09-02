<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    createComment,
    deleteComment,
    resolveComment,
    updateComment,
    type Comment
  } from '$lib/features/page/services/comments';
  import { onRealtime } from '$lib/features/realtime/socket';
  import { plainText } from '$lib/features/page/document';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = { pageId: string; comments: Comment[]; userId?: string | null };
  const { pageId, comments, userId }: Props = $props();

  const t = $derived(locale.t);

  let text = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);
  //: Какой комментарий правят и чем. Правка на месте: отдельный экран ради
  //: одного абзаца увёл бы человека со страницы, которую он обсуждает.
  let editing = $state<string | null>(null);
  let draft = $state('');

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

  function save(event: SubmitEvent, id: string) {
    event.preventDefault();
    if (!draft.trim()) return;
    return act(async () => {
      await updateComment(id, draft);
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

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!text.trim()) return;

    busy = true;
    failure = null;
    try {
      await createComment({ pageId, text });
      text = '';
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
        {#if editing === comment.id}
          <form class="flex flex-col gap-2" onsubmit={(event) => save(event, comment.id)}>
            <textarea
              class="min-h-16 rounded border border-border bg-surface px-3 py-2 text-sm"
              bind:value={draft}
            ></textarea>
            <span class="flex gap-2">
              <Button type="submit" disabled={busy}>{t('Save')}</Button>
              <Button variant="quiet" onclick={() => (editing = null)}>{t('Cancel')}</Button>
            </span>
          </form>
        {:else}
          <p class="whitespace-pre-wrap text-sm" class:text-text-muted={comment.resolvedAt}>
            {plainText(comment.content)}
          </p>
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
              onclick={() => {
                editing = comment.id;
                draft = plainText(comment.content);
              }}
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

  <form class="flex gap-2" onsubmit={submit}>
    <textarea
      class="min-h-20 flex-1 rounded border border-border bg-surface px-3 py-2 text-sm"
      placeholder={t('Write a comment')}
      bind:value={text}
    ></textarea>
    <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Add comment')}</Button>
  </form>

  {#if failure}<Notice message={failure} />{/if}
</section>
