<script lang="ts">
  import { untrack } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import Button from '$lib/components/ui/Button.svelte';
  import { errorText } from '$lib/api/failure';
  import CommentEditor from '../CommentEditor.svelte';
  import { createComment } from '$lib/features/page/services/comments';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    editor: Editor;
    pageId: string;
    /** Пространство страницы. Сужает поиск страниц при упоминании. */
    spaceId?: string | null;
    /** Кто пишет. Пишется в упоминания, как в v1. */
    userId?: string | null;
    at: { left: number; bottom: number };
    onclose: () => void;
  };
  const { editor, pageId, spaceId = null, userId = null, at, onclose }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Отрезок и цитата запоминаются на открытии.
   *
   * Пока человек пишет, выделение уходит в поле ввода, а документ правит сосед.
   * Отрезок в числах пережил бы чужую правку неверно, поэтому одновременно с
   * запоминанием на кусок ставится украшение — оно движется вместе с текстом.
   */
  const anchor = untrack(() => ({
    range: { from: editor.state.selection.from, to: editor.state.selection.to },
    quote: editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ')
  }));
  const range = anchor.range;
  const quote = anchor.quote;

  let field = $state<CommentEditor | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);

  $effect(() => {
    // Внутри `untrack` по той же причине, что и в панели поиска: транзакция
    // редактора правит состояние хозяина, и без этого украшение ставилось бы
    // заново на каждую правку документа.
    untrack(() => editor.chain().setCommentDecoration().run());
  });

  /** Закрыть, не заведя обсуждения: украшение снимается, метка не ставится. */
  function cancel() {
    editor.chain().focus().unsetCommentDecoration().run();
    onclose();
  }

  async function submit(event?: SubmitEvent) {
    event?.preventDefault();
    const content = field?.content();
    if (!content || field?.isEmpty()) return;

    busy = true;
    failure = null;
    try {
      const created = await createComment({ pageId, content, selection: quote });
      // Метка ставится после ответа сервера: до него имени у обсуждения нет, а
      // метка без имени указывала бы в пустоту у всех соединённых.
      editor
        .chain()
        .focus()
        .unsetCommentDecoration()
        .setTextSelection(range)
        .setComment(created.id)
        .run();
      onclose();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<form
  data-component="CommentBox"
  class="fixed z-50 w-72 rounded-md border border-border bg-surface-raised p-2 shadow-lg"
  style:left="{at.left}px"
  style:top="{at.bottom + 8}px"
  onsubmit={submit}
>
  {#if quote}
    <p class="mb-2 line-clamp-3 border-l-2 border-accent pl-2 text-xs text-text-muted">{quote}</p>
  {/if}
  <div class="mb-2">
    <CommentEditor
      bind:this={field}
      {spaceId}
      {userId}
      fail={(error) => (failure = errorText(error, t))}
      onsubmit={() => void submit()}
    />
  </div>
  <div class="flex gap-2">
    <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Add comment')}</Button>
    <Button variant="quiet" onclick={cancel}>{t('Cancel')}</Button>
  </div>
  {#if failure}<p class="mt-2 text-sm text-danger" role="alert">{failure}</p>{/if}
</form>
