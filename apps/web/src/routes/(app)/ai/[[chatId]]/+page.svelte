<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { errorText } from '$lib/api/failure';
  import { deleteChat, sendMessage, type ChatMessage } from '$lib/features/ai/services/chat';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let question = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  // Реплики уже сохранённого разговора приходят с сервера; свои и ответ модели
  // добавляются сюда по ходу потока, до перезагрузки.
  let live = $state<ChatMessage[]>([]);
  /** Что печатает модель прямо сейчас. Отдельно: эта реплика ещё не сохранена. */
  let streaming = $state('');
  /** Чем занята модель: имя инструмента показывается, пока идёт вызов. */
  let tool = $state<string | null>(null);

  const messages = $derived([...(data.chat?.messages ?? []), ...live]);

  $effect(() => {
    // Смена разговора сбрасывает наговоренное: реплики другого разговора уже
    // пришли с сервера.
    data.chat?.id;
    live = [];
    streaming = '';
    tool = null;
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
      for await (const frame of sendMessage({ message: text, chatId: data.chat?.id })) {
        if (frame.type === 'content') streaming += frame.content;
        else if (frame.type === 'tool_call') tool = frame.name;
        else if (frame.type === 'tool_result') tool = null;
        else if (frame.type === 'chat_created') started = frame.chat.id;
        else if (frame.type === 'error') failure = t(frame.error);
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
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  async function drop(chatId: string) {
    failure = null;
    try {
      await deleteChat(chatId);
      if (data.chat?.id === chatId) await goto('/ai');
      else await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    }
  }
</script>

<svelte:head><title>{data.chat?.title ?? t('AI Chat')} · Tessera</title></svelte:head>

<div data-route="ai-chat" class="mx-auto flex max-w-5xl gap-8">
  <aside class="w-56 shrink-0">
    <a
      class="mb-3 block rounded border border-border px-3 py-2 text-center text-sm hover:bg-surface"
      href="/ai"
    >
      {t('New chat')}
    </a>
    <ul data-component="ChatList" class="space-y-1">
      {#each data.chats as chat (chat.id)}
        <li class="group flex items-center justify-between gap-1">
          <a
            class="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-sm hover:bg-surface"
            class:font-medium={chat.id === data.chat?.id}
            href="/ai/{chat.id}"
          >
            {chat.title ?? t('Untitled')}
          </a>
          <button
            class="rounded px-2 py-1 text-xs text-text-muted hover:bg-surface"
            onclick={() => drop(chat.id)}
          >
            {t('Delete')}
          </button>
        </li>
      {:else}
        <li class="px-2 text-sm text-text-muted">{t('No chats found')}</li>
      {/each}
    </ul>
  </aside>

  <section class="min-w-0 flex-1">
    <h1 class="mb-6 text-2xl font-semibold">{data.chat?.title ?? t('AI Chat')}</h1>

    {#if failure}<Notice message={failure} />{/if}

    <div data-component="ChatThread" class="mb-6 space-y-4">
      {#each messages as message (message.id)}
        <article
          class="rounded-lg border border-border p-4"
          class:bg-surface-raised={message.role !== 'user'}
        >
          <p class="mb-1 text-xs uppercase tracking-wide text-text-muted">
            {message.role === 'user' ? t('You') : t('Assistant said:')}
          </p>
          <p class="whitespace-pre-wrap text-sm">{message.content}</p>
        </article>
      {/each}

      {#if streaming}
        <article class="rounded-lg border border-border bg-surface-raised p-4">
          <p class="mb-1 text-xs uppercase tracking-wide text-text-muted">{t('Assistant said:')}</p>
          <p class="whitespace-pre-wrap text-sm">{streaming}</p>
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
      <Textarea
        bind:value={question}
        placeholder={t('Ask anything... Use @ to mention pages')}
        rows={3}
      />
      <div class="mt-2">
        <Button type="submit" disabled={busy || !question.trim()}>
          {busy ? t('Loading...') : t('Send')}
        </Button>
      </div>
    </form>
  </section>
</div>
