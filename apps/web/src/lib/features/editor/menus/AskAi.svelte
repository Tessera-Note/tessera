<script lang="ts">
  import { IconX } from '@tabler/icons-svelte';
  import type { Editor } from '@tiptap/core';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import { errorText } from '$lib/api/failure';
  import { AI_ACTIONS, generateStream } from '$lib/features/ai/services/generate';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = { editor: Editor; onclose: () => void };
  const { editor, onclose }: Props = $props();

  const t = $derived(locale.t);

  /** Что правим: выделенное, а при пустом выделении — весь документ. */
  const source = $derived.by(() => {
    const { from, to } = editor.state.selection;
    return from === to
      ? editor.state.doc.textContent
      : editor.state.doc.textBetween(from, to, '\n');
  });

  let prompt = $state('');
  let answer = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let stop: AbortController | null = null;

  async function ask(action?: string) {
    if (!source.trim()) {
      failure = t('Select text to rewrite.');
      return;
    }
    stop?.abort();
    stop = new AbortController();

    busy = true;
    failure = null;
    answer = '';
    try {
      for await (const piece of generateStream(
        { content: source, action, prompt: prompt || undefined },
        stop.signal
      )) {
        answer += piece;
      }
    } catch (error) {
      // Остановка — не отказ: человек сам прервал ответ.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        failure = errorText(error, t);
      }
    } finally {
      busy = false;
    }
  }

  /**
   * Заменить выделенное ответом.
   *
   * Ответ приходит текстом, а не разметкой: вставляется он текстом же. Разбор
   * markdown здесь означал бы, что модель управляет узлами документа.
   */
  function replace() {
    const { from, to } = editor.state.selection;
    if (from === to) editor.chain().focus().insertContent(answer).run();
    else editor.chain().focus().insertContentAt({ from, to }, answer).run();
    onclose();
  }

  function insertBelow() {
    editor.chain().focus().insertContentAt(editor.state.selection.to, `\n${answer}`).run();
    onclose();
  }
</script>

<div
  data-component="AskAi"
  class="mb-3 rounded-md border border-border bg-surface-raised p-3"
  role="dialog"
  aria-label={t('Ask AI')}
>
  <div class="mb-2 flex items-center gap-2">
    <p class="text-sm font-medium">{t('Ask AI')}</p>
    <button
      class="ml-auto flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
      type="button"
      title={t('Close')}
      aria-label={t('Close')}
      onclick={() => {
        stop?.abort();
        onclose();
      }}
    >
      <IconX size={16} stroke={1.7} />
    </button>
  </div>

  <div class="mb-2 flex flex-wrap gap-1">
    {#each AI_ACTIONS as action (action.value)}
      <button
        class="rounded border border-border px-2 py-1 text-xs text-text-muted hover:bg-surface-hover hover:text-text"
        type="button"
        disabled={busy}
        onclick={() => ask(action.value)}
      >
        {t(action.label)}
      </button>
    {/each}
  </div>

  <form
    class="mb-2 flex gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      void ask('custom');
    }}
  >
    <input
      bind:value={prompt}
      class="h-9 flex-1 rounded border border-border bg-surface px-2 text-sm outline-none placeholder:text-text-muted"
      type="text"
      placeholder={t('Describe what to change')}
      aria-label={t('Describe what to change')}
    />
    <Button type="submit" disabled={busy}>{busy ? t('Loading...') : t('Send')}</Button>
  </form>

  {#if answer}
    <div class="mb-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-2 text-sm">
      {answer}
    </div>
    <div class="flex gap-2">
      <Button disabled={busy} onclick={replace}>{t('Replace selection')}</Button>
      <Button variant="quiet" disabled={busy} onclick={insertBelow}>{t('Insert below')}</Button>
    </div>
  {/if}

  {#if failure}<Notice message={failure} />{/if}
</div>
