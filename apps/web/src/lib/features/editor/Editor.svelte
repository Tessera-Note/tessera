<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import {
    IconArrowBackUp,
    IconArrowForwardUp,
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
    IconListTree,
    IconMinus,
    IconPlus,
    IconSearch,
    IconSourceCode,
    IconSparkles,
    IconStrikethrough
  } from '@tabler/icons-svelte';
  import type { ComponentType } from 'svelte';
  import type { Editor as TiptapEditor } from '@tiptap/core';
  import { errorText } from '$lib/api/failure';
  import { locale } from '$lib/stores/i18n.svelte';
  import {
    ACCESS_CHANGED,
    ACCESS_REVOKED,
    DOCUMENT_UNREADABLE,
    collabAddress,
    collabToken,
    documentName,
    plainText
  } from './collab';
  import { Suggest } from './menus/suggest.svelte';
  import AskAi from './menus/AskAi.svelte';
  import BubbleMenu from './menus/BubbleMenu.svelte';
  import CommentBox from './menus/CommentBox.svelte';
  import DragHandle from './menus/DragHandle.svelte';
  import EmptyStart from './EmptyStart.svelte';
  import FindReplace from './menus/FindReplace.svelte';
  import InsertMenu from './menus/InsertMenu.svelte';
  import LinkPanel from './menus/LinkPanel.svelte';
  import SuggestMenu from './menus/SuggestMenu.svelte';
  import TableMenu from './menus/TableMenu.svelte';
  import Toc from './menus/Toc.svelte';
  import { insertImageFromUrl, kindOf, uploadAndInsert } from './upload';

  type Props = {
    pageId: string;
    /** Содержимое страницы. Показывается, пока не подключился канал правки. */
    content: unknown;
    /** Правка разрешена. Читателю редактор открывается только на чтение. */
    editable: boolean;
    /** Кто правит — имя и цвет для чужого курсора. */
    author: { name: string; color: string };
    /** Кто правит — идентификатор. Пишется в упоминания, как в v1. */
    userId?: string | null;
    /** Пространство страницы. Сужает поиск страниц при упоминании. */
    spaceId?: string | null;
    /**
     * Счёт слов и знаков.
     *
     * Отдаётся наружу, а не показывается здесь: считает его редактор по своему
     * документу, а показывает боковая панель страницы, и второй счёт по
     * разметке расходился бы с первым на каждом узле без текста.
     */
    oncount?: (counted: { words: number; characters: number }) => void;
  };
  const {
    pageId,
    content,
    editable,
    author,
    userId = null,
    spaceId = null,
    oncount
  }: Props = $props();

  const t = $derived(locale.t);

  let host: HTMLDivElement;
  /**
   * Один голый внешний адрес и ничего больше.
   *
   * Только такая вставка разбирается как «добавили ссылку»: адрес посреди
   * абзаца — это текст, и лезть в него с загрузкой картинки незачем.
   */
  const EXTERNAL_ADDRESS = /^https?:\/\/\S+$/i;

  let status = $state<'connecting' | 'ready' | 'offline'>('connecting');
  let failure = $state<string | null>(null);
  /**
   * Причина, по которой тело страницы не показать.
   *
   * Ставится, когда в теле встречается узел, которого нет в схеме этой версии:
   * так бывает после ввоза из чужой системы и после отката приложения. Тело при
   * этом цело — служба редактирования запрещает сохранение такой страницы, —
   * и вместо пустого листа показывается её текст и причина.
   */
  let unreadable = $state<string | null>(null);

  /** Редактор, когда он собран. До этого панель показывать нечего. */
  let ready = $state<TiptapEditor | null>(null);
  /**
   * Документ доехал.
   *
   * До этого редактор пуст всегда — содержимое приходит из Yjs, — и подсказка
   * «начать работу с» мигала бы на каждой странице, включая непустые.
   */
  let synced = $state(false);
  /** Счётчик перерисовки панели: состояние кнопок живёт в самом редакторе. */
  let ticks = $state(0);

  /**
   * Нажата ли кнопка сейчас.
   *
   * Счётчик передаётся первым доводом намеренно: состояние кнопки хранит сам
   * редактор, и без зависимости от счётчика панель не перерисовывалась бы.
   */
  function readActive(
    tick: number,
    name: string | null,
    attributes?: Record<string, unknown>
  ): boolean {
    void tick;
    // Пустое имя у кнопок без состояния: отмена, поиск, оглавление. Спрашивать
    // о них редактор нечего — нажатыми они не бывают.
    if (!name) return false;
    return ready?.isActive(name, attributes) ?? false;
  }

  /** Отказ показывается человеку: молчащая вставка выглядит как поломка. */
  function fail(error: unknown) {
    failure = errorText(error, t);
  }

  // Всё, что нужно закрыть при уходе со страницы. Держится в переменных, а не в
  // состоянии: перерисовка от них не зависит, а забытое соединение живёт до
  // перезагрузки вкладки и продолжает получать чужие правки.
  let editor: TiptapEditor | null = null;
  /** Переключатель права правки. Ставится, когда редактор собран. */
  let setEditable: ((value: boolean) => void) | null = null;
  let provider: { destroy: () => void } | null = null;

  /** Подбор по знаку. Заводится вместе с редактором: без него ему нечего читать. */
  let suggest = $state<Suggest | null>(null);

  /** Открытые окна поверх документа. Каждое закрывается своим способом. */
  let finding = $state(false);
  let toc = $state(false);
  let asking = $state(false);
  let inserting = $state<{ left: number; top: number; bottom: number } | null>(null);
  let linking = $state<{ left: number; bottom: number; existing: string | null } | null>(null);
  let commenting = $state<{ left: number; bottom: number } | null>(null);

  /**
   * Прямоугольник выделения. По нему ставятся всплывающее меню и панель ссылки.
   *
   * `null`, когда выделение пустое: всплывающее меню без выделения нечему
   * показывать, а стоящая посреди текста панель мешает набору.
   */
  const selection = $derived.by(() => {
    void ticks;
    const made = ready;
    if (!made || !made.isEditable) return null;
    const { from, to, empty } = made.state.selection;
    if (empty || from === to) return null;
    const start = made.view.coordsAtPos(from);
    const end = made.view.coordsAtPos(to);
    return {
      left: Math.min(start.left, end.left),
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom)
    };
  });

  /** Каретка внутри таблицы: тогда над документом показывается её панель. */
  const inTable = $derived(readActive(ticks, 'table'));

  onMount(() => {
    let cancelled = false;

    void (async () => {
      try {
        // Библиотеки редактора грузятся здесь, а не сверху: они весят сотни
        // килобайт и на страницах без редактора не нужны вовсе. Набор
        // расширений — с ними: обычный импорт затянул бы его в отрисовку на
        // сервере, где есть пакет на CommonJS, падающий с `require is not
        // defined` и роняющий страницу. Заметно это только по прямой ссылке:
        // переходы внутри приложения идут в браузере и работают.
        const [
          { Editor },
          { Collaboration },
          { CollaborationCaret },
          { HocuspocusProvider },
          Y,
          { editorExtensions }
        ] = await Promise.all([
          import('@tiptap/core'),
          import('@tiptap/extension-collaboration'),
          import('@tiptap/extension-collaboration-caret'),
          import('@hocuspocus/provider'),
          import('yjs'),
          import('./extensions')
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
            ...editorExtensions((key, values) => t(key, values)),
            Collaboration.configure({ document: document_ }),
            CollaborationCaret.configure({ provider: connection, user: author })
          ],
          editorProps: {
            attributes: {
              class: 'tessera-doc focus:outline-none',
              'data-component': 'Editor'
            },
            handlePaste: (_view, event) => paste(event),
            handleDrop: (_view, event) => drop(event as DragEvent)
          }
        });
        editor = made;
        ready = made;
        suggest = new Suggest({
          editor: made,
          pageId,
          spaceId,
          userId,
          locale: locale.current,
          translate: (key) => t(key),
          fail
        });

        // Панель перерисовывается по событиям редактора: своего состояния у
        // кнопок нет, они спрашивают его у самого редактора.
        made.on('transaction', () => {
          // Правка счётчика идёт вне отслеживания. Обработчик вызывается прямо
          // из `editor.commands.*`, а те зовутся в том числе из эффектов: без
          // `untrack` увеличение `ticks` читало бы `ticks` от имени вызвавшего
          // эффекта, и эффект оказывался бы подписан на то, что сам же пишет.
          untrack(() => {
            ticks += 1;
            suggest?.refresh();
            const counted = made.storage.characterCount;
            if (counted) {
              oncount?.({ words: counted.words(), characters: counted.characters() });
            }
          });
        });

        // Нажатия разбираются до самого редактора: пока открыт перечень
        // подбора, стрелка вниз двигает выбор в нём, а не каретку в документе.
        made.view.dom.addEventListener('keydown', keydown, true);

        // Режим меняет переключатель на странице: редактор остаётся тем же,
        // пересоздание потеряло бы и соединение, и место курсора.
        setEditable = (value: boolean) => {
          if (!made.isDestroyed) made.setEditable(value);
        };
        setEditable(editable);

        // Первый счёт сразу: события правки до первой правки не бывает, а
        // панель показывает счёт с открытия страницы.
        const counted = made.storage.characterCount;
        if (counted) oncount?.({ words: counted.words(), characters: counted.characters() });

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

  function keydown(event: KeyboardEvent) {
    if (suggest?.keydown(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Поиск по документу открывается тем же сочетанием, что и поиск браузера:
    // внутри страницы вики ищут по ней, а не по видимому куску.
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      finding = true;
    }
  }

  /**
   * Вставка из буфера.
   *
   * Файл в буфере обмена загружается и заводится узлом; всё остальное
   * отдаётся редактору как есть. Возвращаемое `true` означает «обработано».
   */
  function paste(event: ClipboardEvent): boolean {
    const made = editor;
    if (!made || !made.isEditable) return false;

    const file = event.clipboardData?.files?.[0];
    if (file) {
      event.preventDefault();
      void uploadAndInsert(made, pageId, kindOf(file), file).catch(fail);
      return true;
    }

    // Вставлен один голый адрес и ничего больше. Если по нему картинка, она
    // переносится в своё хранилище: чужая ссылка сегодня открывается, завтра
    // меняется, а на закрытом контуре не видна вовсе. Если не картинка —
    // обычная вставка, её делает сам редактор.
    const pasted = (event.clipboardData?.getData('text/plain') ?? '').trim();
    if (!EXTERNAL_ADDRESS.test(pasted) || !made.state.selection.empty) return false;

    event.preventDefault();
    void insertImageFromUrl(made, pageId, pasted)
      .then((outcome) => {
        if (outcome === 'not-an-image') made.chain().focus().insertContent(pasted).run();
      })
      .catch(fail);
    return true;
  }

  /** Перенос файла мышью. Порядок тот же, что и у вставки из буфера. */
  function drop(event: DragEvent): boolean {
    const made = editor;
    const file = event.dataTransfer?.files?.[0];
    if (!made || !made.isEditable || !file) return false;
    event.preventDefault();
    void uploadAndInsert(made, pageId, kindOf(file), file).catch(fail);
    return true;
  }

  function openLink() {
    const made = editor;
    if (!made || !selection) return;
    const href = made.getAttributes('link').href;
    linking = {
      left: selection.left,
      bottom: selection.bottom,
      existing: typeof href === 'string' ? href : null
    };
  }

  $effect(() => {
    // Довод читается отдельной строкой, до вызова. Ссылка на переключатель
    // появляется только после того, как редактор собрался, а необязательный
    // вызов на пустой ссылке не вычисляет доводов вовсе — тогда `editable` не
    // попадает в зависимости эффекта на первом проходе, и режим чтения и
    // правки перестаёт доходить до редактора навсегда.
    const wanted = editable;
    setEditable?.(wanted);
  });

  onDestroy(() => {
    editor?.view.dom.removeEventListener('keydown', keydown, true);
    editor?.destroy();
    provider?.destroy();
  });
</script>

{#snippet action(
  // Значки из набора Tabler — того же, что в v1. Пакет собран для прежнего
  // вида компонентов Svelte, поэтому и тип прежний.
  Icon: ComponentType,
  label: string,
  name: string | null,
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
      {@render action(IconArrowBackUp, t('Undo'), null, () => ready?.chain().focus().undo().run())}
      {@render action(IconArrowForwardUp, t('Redo'), null, () =>
        ready?.chain().focus().redo().run()
      )}

      <span class="mx-1 h-5 w-px bg-border"></span>

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

      <span class="mx-1 h-5 w-px bg-border"></span>

      <button
        class="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
        type="button"
        title={t('Insert block')}
        aria-label={t('Insert block')}
        onclick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          inserting = { left: box.left, top: box.top, bottom: box.bottom };
        }}
      >
        <IconPlus size={17} stroke={1.7} />
      </button>
      {@render action(IconSearch, t('Find and replace'), null, () => (finding = !finding))}
      {@render action(IconListTree, t('Table of contents'), null, () => (toc = !toc))}
      {@render action(IconSparkles, t('Ask AI'), null, () => (asking = !asking))}
    </div>
  {/if}

  {#if failure}
    <p class="mb-2 text-sm text-danger" role="alert">{failure}</p>
  {:else if status !== 'ready'}
    <p class="mb-2 text-sm text-text-muted">
      {status === 'offline' ? t('Real-time editor connection lost. Retrying...') : t('Loading...')}
    </p>
  {/if}

  {#if ready && editable}
    {#if finding}
      <FindReplace editor={ready} tick={ticks} onclose={() => (finding = false)} />
    {/if}
    {#if toc}
      <Toc editor={ready} tick={ticks} />
    {/if}
    {#if asking}
      <AskAi editor={ready} onclose={() => (asking = false)} />
    {/if}
    {#if inTable}
      <TableMenu editor={ready} />
    {/if}
  {/if}

  <div bind:this={host}></div>

  {#if ready && editable}
    <DragHandle editor={ready} oninsert={(at) => (inserting = at)} />

    {#if selection && !linking && !commenting}
      <BubbleMenu
        editor={ready}
        tick={ticks}
        at={selection}
        onlink={openLink}
        oncomment={() =>
          selection && (commenting = { left: selection.left, bottom: selection.bottom })}
      />
    {/if}

    {#if commenting}
      <CommentBox
        editor={ready}
        {pageId}
        {spaceId}
        {userId}
        at={commenting}
        onclose={() => (commenting = null)}
      />
    {/if}

    {#if linking}
      <LinkPanel
        editor={ready}
        at={linking}
        existing={linking.existing}
        onclose={() => (linking = null)}
      />
    {/if}

    {#if inserting}
      <InsertMenu
        editor={ready}
        {pageId}
        at={inserting}
        {fail}
        onclose={() => (inserting = null)}
      />
    {/if}

    {#if suggest?.open}
      <SuggestMenu
        items={suggest.items}
        index={suggest.index}
        at={suggest.at}
        loading={suggest.loading}
        empty={suggest.empty}
        onpick={(_item, at) => suggest?.pick(at)}
        onhover={(at) => suggest?.hover(at)}
      />
    {/if}
  {/if}
</div>
