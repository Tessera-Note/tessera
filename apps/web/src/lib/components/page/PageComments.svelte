<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { ApiError } from '$lib/api/client';
  import { createComment, type Comment } from '$lib/features/page/services/comments';
  import { plainText } from '$lib/features/page/document';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = { pageId: string; comments: Comment[] };
  const { pageId, comments }: Props = $props();

  const t = $derived(locale.t);

  let text = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

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
      failure = error instanceof ApiError ? t(error.code, error.params) : t('Something went wrong');
    } finally {
      busy = false;
    }
  }
</script>

<section data-component="PageComments" class="mt-12 border-t border-border pt-6">
  <h2 class="mb-4 text-lg font-medium">{t('Comments')}</h2>

  <ul class="mb-6 space-y-3">
    {#each comments as comment (comment.id)}
      <li class="rounded border border-border bg-surface-raised p-3">
        <p class="whitespace-pre-wrap text-sm">{plainText(comment.content)}</p>
        <p class="mt-1 text-xs text-text-muted">
          {new Date(comment.createdAt).toLocaleString(locale.current)}
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
    <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Comment')}</Button>
  </form>

  {#if failure}<Notice message={failure} />{/if}
</section>
