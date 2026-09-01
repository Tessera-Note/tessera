<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
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

  onDestroy(() => {
    editor?.destroy();
    provider?.destroy();
  });
</script>

{#snippet action(
  label: string,
  name: string,
  run: () => void,
  attributes?: Record<string, unknown>
)}
  {@const active = readActive(ticks, name, attributes)}
  <button
    class="rounded px-2 py-1 text-sm hover:bg-surface-hover"
    class:bg-surface-active={active}
    class:font-semibold={active}
    type="button"
    onclick={run}
  >
    {label}
  </button>
{/snippet}

<div data-component="EditorFrame">
  {#if ready && editable}
    <div
      data-component="EditorToolbar"
      class="mb-3 flex flex-wrap gap-1 rounded-md border border-border bg-surface-raised p-1"
    >
      {@render action(t('Bold'), 'bold', () => ready?.chain().focus().toggleBold().run())}
      {@render action(t('Italic'), 'italic', () => ready?.chain().focus().toggleItalic().run())}
      {@render action(t('Strike'), 'strike', () => ready?.chain().focus().toggleStrike().run())}
      {@render action(t('Code'), 'code', () => ready?.chain().focus().toggleCode().run())}
      <span class="mx-1 w-px bg-border"></span>
      {@render action(
        'H1',
        'heading',
        () => ready?.chain().focus().toggleHeading({ level: 1 }).run(),
        { level: 1 }
      )}
      {@render action(
        'H2',
        'heading',
        () => ready?.chain().focus().toggleHeading({ level: 2 }).run(),
        { level: 2 }
      )}
      {@render action(
        'H3',
        'heading',
        () => ready?.chain().focus().toggleHeading({ level: 3 }).run(),
        { level: 3 }
      )}
      <span class="mx-1 w-px bg-border"></span>
      {@render action(t('Bullet list'), 'bulletList', () =>
        ready?.chain().focus().toggleBulletList().run()
      )}
      {@render action(t('Numbered list'), 'orderedList', () =>
        ready?.chain().focus().toggleOrderedList().run()
      )}
      {@render action(t('To-do list'), 'taskList', () =>
        ready?.chain().focus().toggleTaskList().run()
      )}
      <span class="mx-1 w-px bg-border"></span>
      {@render action(t('Quote'), 'blockquote', () =>
        ready?.chain().focus().toggleBlockquote().run()
      )}
      {@render action(t('Code block'), 'codeBlock', () =>
        ready?.chain().focus().toggleCodeBlock().run()
      )}
      {@render action(t('Divider'), 'horizontalRule', () =>
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
