<script lang="ts">
  import { goto } from '$app/navigation';
  import { answerHtml } from '$lib/features/ai/answer';
  import { locale } from '$lib/stores/i18n.svelte';
  import ChatToolGroup from './ChatToolGroup.svelte';

  type Props = {
    role: string;
    content: string;
    /** Вызовы инструментов этой реплики. */
    calls?: unknown;
    /** Идёт ли ответ прямо сейчас. */
    streaming?: boolean;
  };
  const { role, content, calls = null, streaming = false }: Props = $props();

  const t = $derived(locale.t);
  const isUser = $derived(role === 'user');

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      copied = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 2000);
    } catch {
      // Буфер недоступен: браузер не дал права. Показывать нечего.
    }
  }

  $effect(() => () => {
    if (timer) clearTimeout(timer);
  });

  /**
   * Переход по ссылке на страницу — внутренний.
   *
   * Очиститель уже привёл такие ссылки к виду `/s/{space}/p/{slug}`. Без
   * перехвата браузер перезагружает приложение целиком, и открытый разговор
   * пропадает вместе с ним.
   */
  function follow(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

    const anchor = (event.target as HTMLElement | null)?.closest('a');
    const href = anchor?.getAttribute('href');
    if (!href || !href.startsWith('/')) return;

    event.preventDefault();
    void goto(href);
  }
</script>

<!--
  Реплика человека — пузырь справа, ответ модели — обычный текст в потоке, без
  рамки и подписи. Расстановка v1 (`styles/chat-message.module.css`): в
  разговоре двух собеседников подпись у каждой реплики только шумит, сторону и
  так видно.
-->
{#if isUser}
  <div data-component="ChatMessage" data-role="user" class="mb-4 flex justify-end">
    <div
      class="max-w-[75%] whitespace-pre-wrap break-words rounded-[18px] bg-surface-hover px-4 py-2.5 text-[15px] leading-relaxed text-text"
    >
      {content}
    </div>
  </div>
{:else}
  <div data-component="ChatMessage" data-role="assistant" class="mb-4">
    <ChatToolGroup {calls} {streaming} />

    {#if content}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="chat-answer text-[15px] leading-relaxed" onclick={follow}>
        {@html answerHtml(content)}
      </div>
    {/if}

    {#if streaming}
      {#if !content}
        <span class="inline-flex items-center gap-1.5 text-sm text-text-muted">
          <span aria-hidden="true" class="animate-spin">◌</span>
          {t('Thinking')}
        </span>
      {/if}
      <span
        aria-hidden="true"
        class="ml-px inline-block h-4 w-0.5 animate-pulse bg-text align-text-bottom"
      ></span>
    {:else if content}
      <div class="mt-1">
        <button
          type="button"
          class="rounded px-1.5 py-0.5 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          aria-label={t('Copy assistant response')}
          onclick={copy}
        >
          {copied ? t('Copied') : t('Copy')}
        </button>
      </div>
    {/if}
  </div>
{/if}
