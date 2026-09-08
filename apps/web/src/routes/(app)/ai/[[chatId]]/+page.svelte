<script lang="ts">
  import { untrack } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { IconPaperclip } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import ChatEmptyState from '$lib/components/ai/ChatEmptyState.svelte';
  import ChatMessage from '$lib/components/ai/ChatMessage.svelte';
  import { ApiError } from '$lib/api/client';
  import { errorText } from '$lib/api/failure';
  import {
    createChat,
    resolvePlan,
    attachFile,
    sendMessage,
    type ChatFile,
    type ChatMessage as Reply
  } from '$lib/features/ai/services/chat';
  import {
    DELAY,
    insert,
    present,
    queryAt,
    suggestions,
    type Mentioned
  } from '$lib/features/ai/mentions';
  import { toolLabel } from '$lib/features/ai/tools';
  import type { SearchHit } from '$lib/features/search/services/search';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);

  let question = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  /**
   * Упоминания страниц в реплике.
   *
   * Названная страница уходит на сервер идентификатором и кладётся в запрос
   * модели целиком. Без этого она ищет страницу поиском и находит не то, что
   * человек имел в виду.
   */
  let chosen = $state<Mentioned[]>([]);
  /**
   * Файлы, приложенные к следующей реплике.
   *
   * Загружаются сразу при выборе, а не при отправке: ход идёт потоком, и
   * загрузка внутри него оставила бы человека ждать без единого знака.
   */
  let files = $state<ChatFile[]>([]);
  let picker = $state<HTMLInputElement | null>(null);

  async function bring(event: Event) {
    const chosen_file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!chosen_file) return;
    failure = null;
    try {
      files = [...files, await attachFile(chosen_file)];
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      // Поле очищается всегда: без этого тот же файл повторно не выбирается.
      if (picker) picker.value = '';
    }
  }
  let hints = $state<SearchHit[]>([]);
  let highlighted = $state(0);
  let field = $state<HTMLTextAreaElement | null>(null);
  let asking: ReturnType<typeof setTimeout> | null = null;

  /** Ищет по мере набора. Запрос на каждую букву — десяток обращений на слово. */
  function look() {
    if (asking) clearTimeout(asking);
    const caret = field?.selectionStart ?? question.length;
    const query = queryAt(question, caret);
    if (query === null) {
      hints = [];
      return;
    }
    asking = setTimeout(async () => {
      try {
        hints = await suggestions(query);
        highlighted = 0;
      } catch {
        // Отказ поиска не повод мешать разговору: подсказок просто не будет.
        hints = [];
      }
    }, DELAY);
  }

  function pick(hit: SearchHit) {
    const caret = field?.selectionStart ?? question.length;
    const title = hit.title ?? t('Untitled');
    const made = insert(question, caret, title);
    question = made.text;
    chosen = [...chosen, { id: hit.id, title }];
    hints = [];
    // Каретка ставится после вставленного: иначе она остаётся в начале строки,
    // и следующий набранный знак уходит не туда.
    queueMicrotask(() => field?.setSelectionRange(made.caret, made.caret));
    field?.focus();
  }

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

  /**
   * В каком разговоре идёт ход прямо сейчас.
   *
   * Обычной переменной, а не состоянием: её читает эффект ниже, а пишет ход, и
   * состояние здесь подписало бы эффект на то, что он же и различает. Нужна
   * она затем, что адрес разговора ставится в начале хода: без этого признака
   * смена адреса читалась бы как переход в другой разговор, и наговоренное
   * стиралось бы с экрана посреди ответа.
   */
  let inFlight: string | null = null;

  $effect(() => {
    // Смена разговора сбрасывает наговоренное: реплики другого разговора уже
    // пришли с сервера. Кроме того разговора, в котором ход идёт сейчас: его
    // адрес поставлен этим же ходом, и реплик на сервере ещё нет.
    const now = data.chat?.id ?? null;
    if (now && now === inFlight) return;
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
    // Приложенное снимается вместе с отправкой: файлы относятся к этой реплике,
    // а не к разговору целиком.
    const attached = files;
    files = [];
    question = '';

    try {
      let started: string | null = null;
      // Разговор заводится до отправки, и адрес ставится сразу: ход с
      // инструментами длится десятки секунд, и всё это время обновление
      // вкладки теряло бы ответ из виду. Отказ заведения не отменяет реплику —
      // сервер заведёт разговор сам и пришлёт его кадром, как раньше.
      let inside = data.chat?.id ?? null;
      if (!inside) {
        try {
          inside = (await createChat()).id;
          started = inside;
          inFlight = inside;
          await goto(`/ai/${inside}`, { replaceState: true, noScroll: true, keepFocus: true });
        } catch {
          inside = null;
          inFlight = null;
        }
      }

      stopper = new AbortController();
      for await (const frame of sendMessage(
        {
          message: text,
          chatId: inside ?? undefined,
          // Только те упоминания, что остались в строке: стёртое человеком не
          // должно уходить на сервер.
          mentionedPageIds: present(text, chosen).map((one) => one.id),
          attachmentIds: attached.map((one) => one.id)
        },
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

      // Признак снимается до перечитывания: дальше реплики приходят с сервера,
      // и наговоренное на экране обязано уступить им место, иначе оно
      // удвоится.
      inFlight = null;
      if (started) {
        // Перечитывание уже по своему адресу: в него дописаны и реплика, и
        // ответ, а в перечне сбоку разговор появляется под своим названием.
        await goto(`/ai/${started}`, { invalidateAll: true });
      } else {
        await invalidateAll();
      }
    } catch (error) {
      // Остановка это не отказ: человек сам прервал ход. Но сказанное до
      // остановки остаётся на экране: человек читал ответ и прервал его
      // потому, что прочитанного хватило, — стереть прочитанное значит
      // наказать за нажатие. Так же в v1 (`hooks/use-chat-stream.ts`).
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (streaming) live = [...live, draft('assistant', streaming)];
      } else {
        failure = errorText(error, t);
      }
    } finally {
      streaming = '';
      liveCalls = [];
      busy = false;
      answering = false;
      stopper = null;
      inFlight = null;
    }
  }

  function stop() {
    stopper?.abort();
  }

  /**
   * Вопрос, заданный с главной.
   *
   * Приходит доводом адреса и отправляется сам: человек уже нажал «отправить»
   * там, и требовать второго нажатия здесь незачем. Довод сразу убирается из
   * адреса — иначе обновление вкладки задаёт тот же вопрос заново.
   */
  let asked = false;

  $effect(() => {
    const wanted = page.url.searchParams.get('ask');
    if (!wanted || asked || busy) return;
    asked = true;
    untrack(() => {
      question = wanted;
    });
    void goto('/ai', { replaceState: true, noScroll: true, keepFocus: true }).then(ask);
  });

  /** Enter отправляет, Shift+Enter переносит строку. Как в v1. */
  function onKeydown(event: KeyboardEvent) {
    // Пока открыт перечень подсказок, стрелки и ввод принадлежат ему: так же
    // устроен подбор в редакторе.
    if (hints.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        highlighted = (highlighted + 1) % hints.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlighted = (highlighted - 1 + hints.length) % hints.length;
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        pick(hints[highlighted]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hints = [];
        return;
      }
    }

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
    class="relative shrink-0 px-2 pb-2 pt-1"
    onsubmit={(event) => {
      event.preventDefault();
      void ask();
    }}
  >
    <!--
      Подсказки над полем, а не под ним: поле стоит внизу экрана, и список под
      ним уехал бы за край.
    -->
    {#if hints.length > 0}
      <ul
        data-component="MentionHints"
        class="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-60 overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
      >
        {#each hints as hit, at (hit.id)}
          <li>
            <button
              class="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
              class:bg-surface-active={at === highlighted}
              type="button"
              onmousedown={(event) => {
                // До `blur`: иначе поле теряет фокус, список закрывается, и
                // нажатие приходит уже в пустоту.
                event.preventDefault();
                pick(hit);
              }}
            >
              {hit.title ?? t('Untitled')}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if files.length > 0}
      <!-- Приложенное видно до отправки: иначе человек не знает, что уйдёт
           вместе с вопросом. -->
      <ul data-component="ChatFiles" class="mb-1 flex flex-wrap gap-2 px-1">
        {#each files as one (one.id)}
          <li
            class="flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 text-xs"
          >
            <span class="max-w-48 truncate">{one.fileName}</span>
            <button
              class="text-text-muted hover:text-text"
              type="button"
              aria-label={t('Remove')}
              onclick={() => (files = files.filter((other) => other.id !== one.id))}
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <div
      class="flex items-end gap-2 rounded-2xl border border-border-input bg-surface px-3 py-2 focus-within:border-accent"
    >
      <!-- Выбор файла спрятан за кнопкой: сам `input type=file` рисуется
           каждым браузером по-своему и не встаёт в расстановку. -->
      <input bind:this={picker} class="hidden" type="file" onchange={bring} />
      <button
        type="button"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-surface-hover hover:text-text"
        aria-label={t('Attach file')}
        onclick={() => picker?.click()}
      >
        <IconPaperclip size={17} stroke={1.7} />
      </button>
      <textarea
        bind:this={field}
        class="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent py-1.5 text-sm text-text outline-none placeholder:text-text-muted"
        rows={1}
        placeholder={t('Ask anything...')}
        bind:value={question}
        onkeydown={onKeydown}
        oninput={look}
        onblur={() => setTimeout(() => (hints = []), 150)}
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
