<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import ChatEmptyState from '$lib/components/ai/ChatEmptyState.svelte';
  import ChatMessage from '$lib/components/ai/ChatMessage.svelte';
  import { ApiError } from '$lib/api/client';
  import { errorText } from '$lib/api/failure';
  import {
    resolvePlan,
    sendMessage,
    type ChatMessage as Reply
  } from '$lib/features/ai/services/chat';
  import { toolLabel } from '$lib/features/ai/tools';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let question = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  /**
   * Идёт ли ход прямо сейчас.
   *
   * Отдельно от `busy`, который держится ещё и на время перехода к адресу
   * заведённого разговора. По `busy` под готовым ответом успевала появиться
   * вторая пустая реплика с надписью «Думаю».
   */
  let answering = $state(false);

  /** Чем остановить идущий поток. Ход длится десятки секунд. */
  let stopper: AbortController | null = null;

  /**
   * План необратимых действий, ждущий решения.
   *
   * Сервер такие шаги не выполняет, а сохраняет и ждёт ответа. Без показа плана
   * они висят вечно, и разговор выглядит незаконченным.
   */
  let plan = $state<{ messageId: string; steps: { tool: string; args: unknown }[] } | null>(null);

  // Реплики уже сохранённого разговора приходят с сервера; свои и ответ модели
  // добавляются сюда по ходу потока, до перезагрузки.
  let live = $state<Reply[]>([]);
  /** Что печатает модель прямо сейчас. Отдельно: эта реплика ещё не сохранена. */
  let streaming = $state('');
  /** Шаги идущего хода. До сохранения они есть только здесь. */
  let liveCalls = $state<{ id: string; name: string; args: unknown; result?: unknown }[]>([]);

  const messages = $derived([...(data.chat?.messages ?? []), ...live]);
  const empty = $derived(messages.length === 0 && !streaming && !busy);

  // Сохранённый план перечитывается из последней реплики: разговор могли
  // открыть заново, а решение по нему всё ещё ждут.
  const storedPlan = $derived(findStoredPlan(data.chat?.messages ?? []));

  function findStoredPlan(
    saved: Reply[]
  ): { messageId: string; steps: { tool: string; args: unknown }[] } | null {
    for (let index = saved.length - 1; index >= 0; index -= 1) {
      const one = saved[index];
      const meta = (one.metadata ?? {}) as {
        pendingPlan?: { steps: { tool: string; args: unknown }[] };
        planStatus?: string;
      };
      if (meta.pendingPlan && !meta.planStatus) {
        return { messageId: one.id, steps: meta.pendingPlan.steps ?? [] };
      }
    }
    return null;
  }

  $effect(() => {
    // Смена разговора сбрасывает наговоренное: реплики другого разговора уже
    // пришли с сервера.
    data.chat?.id;
    live = [];
    streaming = '';
    liveCalls = [];
    plan = null;
  });

  /**
   * Прокрутка транскрипта.
   *
   * Своя, а не общая прокрутка страницы: пока идёт ответ, экран должен ехать за
   * последней строкой, но только если человек сам не ушёл читать написанное
   * выше. Признак «внизу» держится обычной переменной, а не состоянием: эффект
   * ниже пишет её, и состояние здесь означало бы чтение того же, что он пишет.
   */
  const BOTTOM_GAP = 32;
  const SMOOTH_MS = 600;

  let scroller = $state<HTMLDivElement | null>(null);
  let showDown = $state(false);
  let stick = true;
  let moving = false;

  function toBottom(behavior: ScrollBehavior) {
    const box = scroller;
    if (!box) return;
    moving = true;
    box.scrollTo({ top: box.scrollHeight - box.clientHeight, behavior });
    stick = true;
    showDown = false;
    if (behavior === 'smooth') setTimeout(() => (moving = false), SMOOTH_MS);
    else moving = false;
  }

  function onScroll() {
    const box = scroller;
    if (!box || moving) return;
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
    stick = gap <= BOTTOM_GAP;
    showDown = !stick;
  }

  $effect(() => {
    // Мгновенно, пока идёт поток: плавная прокрутка не успевает за строками.
    streaming;
    liveCalls.length;
    if (stick) toBottom('instant');
  });

  $effect(() => {
    const list = messages;
    const last = list[list.length - 1];
    // Свою реплику человек видит всегда, даже если читал написанное выше.
    if (last?.role === 'user' || stick) toBottom('smooth');
  });

  function draft(role: string, content: string): Reply {
    return {
      id: `${role}-${live.length}-${Date.now()}`,
      role,
      content,
      toolCalls: null,
      metadata: null,
      createdAt: null
    };
  }

  async function ask() {
    const text = question.trim();
    if (!text || busy) return;

    busy = true;
    answering = true;
    failure = null;
    streaming = '';
    liveCalls = [];
    live = [...live, draft('user', text)];
    question = '';

    try {
      let started: string | null = null;
      stopper = new AbortController();
      for await (const frame of sendMessage(
        { message: text, chatId: data.chat?.id },
        stopper.signal
      )) {
        if (frame.type === 'content') streaming += frame.content;
        else if (frame.type === 'tool_call')
          liveCalls = [
            ...liveCalls,
            { id: `${frame.name}-${liveCalls.length}`, name: frame.name, args: frame.arguments }
          ];
        else if (frame.type === 'tool_result')
          liveCalls = liveCalls.map((one, index) =>
            index === liveCalls.length - 1
              ? { ...one, result: frame.isError ? 'error' : 'ok' }
              : one
          );
        else if (frame.type === 'chat_created') started = frame.chat.id;
        else if (frame.type === 'plan') plan = { messageId: frame.messageId, steps: frame.steps };
        else if (frame.type === 'error') {
          // Через общий разбор: в кадре приходит код и текст сервера, и
          // показывать код человеку нельзя.
          failure = errorText(new ApiError(500, frame.error, frame.message ?? '', {}), t);
        }
      }

      answering = false;
      if (streaming) live = [...live, draft('assistant', streaming)];
      streaming = '';
      liveCalls = [];

      if (started) {
        // Разговор завёлся первой репликой: дальше он живёт по своему адресу.
        await goto(`/ai/${started}`, { invalidateAll: true });
      } else {
        await invalidateAll();
      }
    } catch (error) {
      // Остановка это не отказ: человек сам прервал ход.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        failure = errorText(error, t);
      }
    } finally {
      busy = false;
      answering = false;
      stopper = null;
    }
  }

  function stop() {
    stopper?.abort();
  }

  /** Enter отправляет, Shift+Enter переносит строку. Как в v1. */
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void ask();
  }

  async function decide(decision: 'confirm' | 'reject') {
    const waiting = plan ?? storedPlan;
    if (!waiting) return;

    failure = null;
    try {
      await resolvePlan(waiting.messageId, decision);
      plan = null;
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    }
  }
</script>

<svelte:head><title>{data.chat?.title ?? t('AI Chat')} · Tessera</title></svelte:head>

<!--
  Расстановка v1 (`styles/ai-chat.module.css`): транскрипт прокручивается сам, а
  поле ввода стоит внизу и не уезжает. Общая прокрутка страницы уводила поле за
  край, и на длинном разговоре писать было нечем.
-->
<div
  data-route="ai-chat"
  class="mx-auto flex h-[calc(100vh-var(--spacing-header)-2rem)] max-w-[900px] flex-col"
>
  {#if failure}<Notice message={failure} />{/if}

  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      data-component="ChatThread"
      class="min-h-0 flex-1 overflow-y-auto px-2 py-4"
      aria-label={t('Chat transcript')}
      bind:this={scroller}
      onscroll={onScroll}
    >
      {#if empty}
        <ChatEmptyState onpick={(prompt) => (question = prompt)} />
      {/if}

      {#each messages as message (message.id)}
        <ChatMessage role={message.role} content={message.content} calls={message.toolCalls} />
      {/each}

      {#if answering}
        <ChatMessage role="assistant" content={streaming} calls={liveCalls} streaming />
      {/if}

      {#if plan ?? storedPlan}
        {@const waiting = plan ?? storedPlan}
        <article
          data-component="PendingPlan"
          class="mb-4 rounded-md border border-border bg-surface-raised p-4"
        >
          <p class="mb-2 text-sm font-medium">{t('Confirm these changes')}</p>
          <ul class="mb-3 space-y-1 text-sm text-text-muted">
            {#each waiting?.steps ?? [] as step, index (index)}
              <li>{toolLabel(step.tool, t)}</li>
            {/each}
          </ul>
          <div class="flex gap-2">
            <Button onclick={() => decide('confirm')}>{t('Confirm')}</Button>
            <Button variant="quiet" onclick={() => decide('reject')}>{t('Reject')}</Button>
          </div>
        </article>
      {/if}
    </div>

    {#if showDown}
      <button
        type="button"
        class="absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface-raised text-text-muted shadow-md transition-colors hover:bg-surface-hover hover:text-text"
        aria-label={t('Scroll to bottom')}
        onclick={() => toBottom('smooth')}
      >
        <span aria-hidden="true">↓</span>
      </button>
    {/if}
  </div>

  <form
    class="shrink-0 px-2 pb-2 pt-1"
    onsubmit={(event) => {
      event.preventDefault();
      void ask();
    }}
  >
    <div
      class="flex items-end gap-2 rounded-2xl border border-border-input bg-surface px-3 py-2 focus-within:border-accent"
    >
      <textarea
        class="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent py-1.5 text-sm text-text outline-none placeholder:text-text-muted"
        rows={1}
        placeholder={t('Ask anything...')}
        bind:value={question}
        onkeydown={onKeydown}
      ></textarea>
      {#if busy}
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-text hover:bg-accent-hover"
          aria-label={t('Cancel')}
          onclick={stop}
        >
          <span aria-hidden="true">■</span>
        </button>
      {:else}
        <button
          type="submit"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-text transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('Send')}
          disabled={!question.trim()}
        >
          <span aria-hidden="true">↑</span>
        </button>
      {/if}
    </div>
  </form>
</div>
