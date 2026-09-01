<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    IconBlockquote,
    IconBold,
    IconCode,
    IconH1,
    IconH2,
    IconH3,
    IconItalic,
    IconList,
    IconListCheck,
    IconListNumbers,
    IconMinus,
    IconSourceCode,
    IconStrikethrough
  } from '@tabler/icons-svelte';
  import type { ComponentType } from 'svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import { collabAddress, collabToken, documentName } from './collab';
  import { editorExtensions } from './extensions';

  type Props = {
    pageId: string;
    /** Содержимое страницы. Показывается, пока не подключился канал правки. */
    content: unknown;
    /** Правка разрешена. Читателю редактор открывается только на чтение. */
    editable: boolean;
    /** Кто правит — имя и цвет для чужого курсора. */
    author: { name: string; color: string };
  };
  const { pageId, content, editable, author }: Props = $props();

  const t = $derived(locale.t);

  let host: HTMLDivElement;
  let status = $state<'connecting' | 'ready' | 'offline'>('connecting');
  let failure = $state<string | null>(null);

  // Всё, что нужно закрыть при уходе со страницы. Держится в переменных, а не в
  // состоянии: перерисовка от них не зависит, а забытое соединение живёт до
  // перезагрузки вкладки и продолжает получать чужие правки.
  type Commands = {
    destroy: () => void;
    isActive: (name: string, attributes?: Record<string, unknown>) => boolean;
    chain: () => {
      focus: () => Record<string, (...args: unknown[]) => { run: () => void }>;
    };
  };

  /** Редактор, когда он собран. До этого панель показывать нечего. */
  let ready = $state<Commands | null>(null);
  /** Счётчик перерисовки панели: состояние кнопок живёт в самом редакторе. */
  let ticks = $state(0);

  /**
   * Нажата ли кнопка сейчас.
   *
   * Счётчик передаётся первым доводом намеренно: состояние кнопки хранит сам
   * редактор, и без зависимости от счётчика панель не перерисовывалась бы.
   */
  function readActive(tick: number, name: string, attributes?: Record<string, unknown>): boolean {
    void tick;
    return ready?.isActive(name, attributes) ?? false;
  }

  let editor: { destroy: () => void } | null = null;
  /** Переключатель права правки. Ставится, когда редактор собран. */
  let setEditable: ((value: boolean) => void) | null = null;
  let provider: { destroy: () => void } | null = null;

  onMount(() => {
    let cancelled = false;

    void (async () => {
      try {
        // Библиотеки редактора грузятся здесь, а не сверху: они весят сотни
        // килобайт и на страницах без редактора не нужны вовсе.
        const [{ Editor }, { Collaboration }, { CollaborationCaret }, { HocuspocusProvider }, Y] =
          await Promise.all([
            import('@tiptap/core'),
            import('@tiptap/extension-collaboration'),
            import('@tiptap/extension-collaboration-caret'),
            import('@hocuspocus/provider'),
            import('yjs')
          ]);

        const { token } = await collabToken();
        if (cancelled) return;

        const document_ = new Y.Doc();
        const connection = new HocuspocusProvider({
          url: collabAddress(),
          name: documentName(pageId),
          document: document_,
          token,
          onStatus: ({ status: state }) => {
            status = state === 'connected' ? 'ready' : 'connecting';
          },
          onDisconnect: () => {
            status = 'offline';
          }
        });
        provider = connection;

        const made = new Editor({
          element: host,
          editable,
          extensions: [
            ...editorExtensions(),
            Collaboration.configure({ document: document_ }),
            CollaborationCaret.configure({ provider: connection, user: author })
          ],
          editorProps: {
            attributes: {
              class: 'tessera-doc focus:outline-none',
              'data-component': 'Editor'
            }
          }
        });
        editor = made;
        ready = made as unknown as Commands;
        // Панель перерисовывается по событиям редактора: своего состояния у
        // кнопок нет, они спрашивают его у самого редактора.
        made.on('transaction', () => {
          ticks += 1;
        });

        // Режим меняет переключатель на странице: редактор остаётся тем же,
        // пересоздание потеряло бы и соединение, и место курсора.
        setEditable = (value: boolean) => {
          if (!made.isDestroyed) made.setEditable(value);
        };
        setEditable(editable);

        // Содержимое приходит из документа Yjs. Первым подключившимся его надо
        // засеять: пустой документ означал бы, что страница потеряла текст.
        connection.on('synced', () => {
          if (made.isDestroyed) return;
          if (made.isEmpty && content) {
            made.commands.setContent(content as never, { emitUpdate: false });
          }
        });
      } catch (error) {
        // Причина показывается как есть: отказ здесь означает, что редактор не
        // собрался, и общая фраза не даёт понять, чинить канал или разметку.
        failure = error instanceof Error ? error.message : String(error);
        status = 'offline';
        console.error('Редактор не открылся', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    setEditable?.(editable);
  });

  onDestroy(() => {
    editor?.destroy();
    provider?.destroy();
  });
</script>

{#snippet action(
  // Значки из набора Tabler — того же, что в v1. Пакет собран для прежнего
  // вида компонентов Svelte, поэтому и тип прежний.
  Icon: ComponentType,
  label: string,
  name: string,
  run: () => void,
  attributes?: Record<string, unknown>
)}
  {@const active = readActive(ticks, name, attributes)}
  <button
    class="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
    class:bg-surface-active={active}
    class:text-text={active}
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={active}
    onclick={run}
  >
    <Icon size={17} stroke={1.7} />
  </button>
{/snippet}

<div data-component="EditorFrame">
  {#if ready && editable}
    <div
      data-component="EditorToolbar"
      class="mb-3 flex flex-wrap items-center gap-0.5 border-b border-border pb-2"
    >
      {@render action(IconBold, t('Bold'), 'bold', () => ready?.chain().focus().toggleBold().run())}
      {@render action(IconItalic, t('Italic'), 'italic', () =>
        ready?.chain().focus().toggleItalic().run()
      )}
      {@render action(IconStrikethrough, t('Strike'), 'strike', () =>
        ready?.chain().focus().toggleStrike().run()
      )}
      {@render action(IconCode, t('Code'), 'code', () => ready?.chain().focus().toggleCode().run())}

      <span class="mx-1 h-5 w-px bg-border"></span>

      {@render action(
        IconH1,
        t('Heading 1'),
        'heading',
        () => ready?.chain().focus().toggleHeading({ level: 1 }).run(),
        { level: 1 }
      )}
      {@render action(
        IconH2,
        t('Heading 2'),
        'heading',
        () => ready?.chain().focus().toggleHeading({ level: 2 }).run(),
        { level: 2 }
      )}
      {@render action(
        IconH3,
        t('Heading 3'),
        'heading',
        () => ready?.chain().focus().toggleHeading({ level: 3 }).run(),
        { level: 3 }
      )}

      <span class="mx-1 h-5 w-px bg-border"></span>

      {@render action(IconList, t('Bullet list'), 'bulletList', () =>
        ready?.chain().focus().toggleBulletList().run()
      )}
      {@render action(IconListNumbers, t('Numbered list'), 'orderedList', () =>
        ready?.chain().focus().toggleOrderedList().run()
      )}
      {@render action(IconListCheck, t('To-do list'), 'taskList', () =>
        ready?.chain().focus().toggleTaskList().run()
      )}

      <span class="mx-1 h-5 w-px bg-border"></span>

      {@render action(IconBlockquote, t('Quote'), 'blockquote', () =>
        ready?.chain().focus().toggleBlockquote().run()
      )}
      {@render action(IconSourceCode, t('Code block'), 'codeBlock', () =>
        ready?.chain().focus().toggleCodeBlock().run()
      )}
      {@render action(IconMinus, t('Divider'), 'horizontalRule', () =>
        ready?.chain().focus().setHorizontalRule().run()
      )}
    </div>
  {/if}

  {#if failure}
    <p class="mb-2 text-sm text-danger" role="alert">{t('Something went wrong')}</p>
  {:else if status !== 'ready'}
    <p class="mb-2 text-sm text-text-muted">
      {status === 'offline' ? t('Real-time editor connection lost. Retrying...') : t('Loading...')}
    </p>
  {/if}

  <div bind:this={host}></div>
</div>
