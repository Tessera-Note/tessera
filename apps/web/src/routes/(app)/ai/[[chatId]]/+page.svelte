<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { ApiError } from '$lib/api/client';
  import { errorText } from '$lib/api/failure';
  import { resolvePlan, sendMessage, type ChatMessage } from '$lib/features/ai/services/chat';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let question = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

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
  let live = $state<ChatMessage[]>([]);
  /** Что печатает модель прямо сейчас. Отдельно: эта реплика ещё не сохранена. */
  let streaming = $state('');
  /** Чем занята модель: имя инструмента показывается, пока идёт вызов. */
  let tool = $state<string | null>(null);

  const messages = $derived([...(data.chat?.messages ?? []), ...live]);

  // Сохранённый план перечитывается из последней реплики: разговор могли
  // открыть заново, а решение по нему всё ещё ждут.
  const storedPlan = $derived(findStoredPlan(data.chat?.messages ?? []));

  function findStoredPlan(
    saved: ChatMessage[]
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
    tool = null;
    plan = null;
  });

  function draft(role: string, content: string): ChatMessage {
    return {
      id: `${role}-${live.length}-${Date.now()}`,
      role,
      content,
      toolCalls: null,
      metadata: null,
      createdAt: null
    };
  }

  async function ask(event: SubmitEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;

    busy = true;
    failure = null;
    streaming = '';
    tool = null;
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
        else if (frame.type === 'tool_call') tool = frame.name;
        else if (frame.type === 'tool_result') tool = null;
        else if (frame.type === 'chat_created') started = frame.chat.id;
        else if (frame.type === 'plan') plan = { messageId: frame.messageId, steps: frame.steps };
        else if (frame.type === 'error') {
          // Через общий разбор: в кадре приходит код и текст сервера, и
          // показывать код человеку нельзя.
          failure = errorText(new ApiError(500, frame.error, frame.message ?? '', {}), t);
        }
      }

      if (streaming) live = [...live, draft('assistant', streaming)];
      streaming = '';
      tool = null;

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
      stopper = null;
    }
  }

  function stop() {
    stopper?.abort();
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

<div data-route="ai-chat" class="mx-auto max-w-3xl">
  <section class="min-w-0">
    <h1 class="mb-6 text-2xl font-semibold">{data.chat?.title ?? t('AI Chat')}</h1>

    {#if failure}<Notice message={failure} />{/if}

    <div data-component="ChatThread" class="mb-6 space-y-4">
      {#each messages as message (message.id)}
        <article
          class="rounded border border-border p-4"
          class:bg-surface-raised={message.role !== 'user'}
        >
          <p class="mb-1 text-xs uppercase tracking-wide text-text-muted">
            {message.role === 'user' ? t('You') : t('AI')}
          </p>
          <p class="whitespace-pre-wrap text-sm">{message.content}</p>
        </article>
      {/each}

      {#if streaming}
        <article class="card-soft rounded-md border border-border bg-surface-raised p-5">
          <p class="mb-1 text-xs uppercase tracking-wide text-text-muted">{t('AI')}</p>
          <p class="whitespace-pre-wrap text-sm">{streaming}</p>
        </article>
      {/if}

      {#if plan ?? storedPlan}
        {@const waiting = plan ?? storedPlan}
        <article data-component="PendingPlan" class="rounded border border-border p-4">
          <p class="mb-2 text-sm font-medium">{t('Confirm these changes')}</p>
          <ul class="mb-3 space-y-1 text-sm text-text-muted">
            {#each waiting?.steps ?? [] as step, index (index)}
              <li>{step.tool}</li>
            {/each}
          </ul>
          <div class="flex gap-2">
            <Button onclick={() => decide('confirm')}>{t('Confirm')}</Button>
            <Button variant="quiet" onclick={() => decide('reject')}>{t('Reject')}</Button>
          </div>
        </article>
      {/if}

      {#if tool}
        <p class="text-sm text-text-muted">{t('Thinking')} {tool}</p>
      {/if}

      {#if messages.length === 0 && !streaming}
        <p class="text-sm text-text-muted">{t('No conversations yet')}</p>
      {/if}
    </div>

    <form onsubmit={ask}>
      <Textarea bind:value={question} placeholder={t('Ask anything...')} rows={3} />
      <div class="mt-2">
        <Button type="submit" disabled={busy || !question.trim()}>
          {busy ? t('Loading...') : t('Send')}
        </Button>
        {#if busy}
          <Button variant="quiet" onclick={stop}>{t('Cancel')}</Button>
        {/if}
      </div>
    </form>
  </section>
</div>
