<script lang="ts">
  import { untrack } from 'svelte';
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
    nextStatus,
    plainText,
    seedDecision
  } from './collab';
  import { presentPeople, type Present } from './presence';
  import { Suggest } from './menus/suggest.svelte';
  import AskAi from './menus/AskAi.svelte';
  import BubbleMenu from './menus/BubbleMenu.svelte';
  import CommentBox from './menus/CommentBox.svelte';
  import ConnectionRefused from './ConnectionRefused.svelte';
  import DocumentView from './DocumentView.svelte';
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
    /**
     * Кто правит.
     *
     * Имя и цвет рисуют чужой курсор в тексте. Идентификатор и аватар нужны
     * перечню присутствующих: тот же набор объявляется в канале, и второй
     * источник расходился бы с курсорами.
     */
    author: { id?: string | null; name: string; color: string; avatarUrl?: string | null };
    /** Кто правит — идентификатор. Пишется в упоминания, как в v1. */
    userId?: string | null;
    /**
     * Показывать ли полосу форматирования.
     *
     * Личная настройка человека («Закреплённая панель редактора»). Умолчание
     * — показывать: так было до появления настройки.
     */
    toolbar?: boolean;
    /**
     * Разрешена ли правка текста помощником.
     *
     * Настройка рабочего пространства. Выключенная возможность обязана
     * пропадать с экрана, а не отвечать отказом на нажатие: кнопка, которая
     * всегда отказывает, читается как поломка.
     */
    generative?: boolean;
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
    /**
     * Кто ещё открыл страницу.
     *
     * Отдаётся наружу, а не показывается здесь: перечень стоит внизу листа,
     * вне редактора, и держать его внутри значило бы рисовать его поверх
     * текста.
     */
    onpresence?: (people: Present[]) => void;
  };
  const {
    pageId,
    content,
    editable,
    author,
    userId = null,
    spaceId = null,
    toolbar = true,
    generative = true,
    oncount,
    onpresence
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
  /**
   * Служба редактирования отказала в подключении.
   *
   * Сокет при отказе открыт, и состояние канала выглядит рабочим, а правки
   * никуда не уходят. Снимается, если канал позже всё же прошёл проверку.
   */
  let refused = $state(false);

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
  /** Хранилище документа в браузере. Держит правки, набранные без связи. */
  let persistence: { destroy: () => void } | null = null;
  /** Предел ожидания хранилища. Снимается, как только оно ответило. */
  let waiting: ReturnType<typeof setTimeout> | null = null;

  /**
   * Сколько ждать хранилище браузера.
   *
   * Обычно оно отвечает за миллисекунды. Но открыться оно может и не суметь —
   * в окне без сохранения данных и при запрещённых данных сайта, — а ответа об
   * этом не приходит вовсе. Без предела страница осталась бы на чтении навсегда.
   */
  const STORAGE_WAIT = 3000;

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

  /**
   * Пуст ли документ. Счётчик — зависимость: пустоту знает сам редактор.
   */
  const empty = $derived.by(() => {
    void ticks;
    return synced && (ready?.isEmpty ?? false);
  });

  /**
   * Редактор пересобирается при смене страницы.
   *
   * Эффект, а не `onMount`: маршрут страницы один на все страницы
   * пространства, и при переходе по дереву SvelteKit оставляет тот же
   * экземпляр компонента — `onMount` второй раз не вызывается. Собранный
   * однажды редактор оставался привязан к документу прежней страницы.
   *
   * В зависимостях только `pageId`. Остальные свойства читаются после первого
   * `await`, то есть вне отслеживания: смена имени правящего или переключение
   * чтения и правки не должны рвать соединение и терять место курсора.
   */
  $effect(() => {
    const page = pageId;
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
          { IndexeddbPersistence },
          Y,
          { editorExtensions }
        ] = await Promise.all([
          import('@tiptap/core'),
          import('@tiptap/extension-collaboration'),
          import('@tiptap/extension-collaboration-caret'),
          import('@hocuspocus/provider'),
          import('y-indexeddb'),
          import('yjs'),
          import('./extensions')
        ]);
        // Уход со страницы мог случиться, пока грузились библиотеки. Собранные
        // после уборки редактор и соединение никто уже не закроет.
        if (cancelled) return;

        const name = documentName(page);
        const document_ = new Y.Doc();
        // Документ хранится и в самом браузере. Без этого правка, сделанная при
        // обрыве связи, живёт только в памяти вкладки: перезагрузка до возврата
        // связи стирает её без следа. Хранившееся уходит на сервер тем же
        // порядком, что и набранное только что.
        const local = new IndexeddbPersistence(name, document_);
        persistence = local;

        const connection = new HocuspocusProvider({
          url: collabAddress(name),
          name,
          document: document_,
          // Токен спрашивается перед каждым рукопожатием, а не берётся однажды:
          // он живёт сутки, а вкладка живёт дольше. С просроченным канал не
          // пускает, и вкладка осталась бы без связи навсегда — вместе со всем,
          // что в ней набрано.
          token: async () => (await collabToken()).token,
          onStatus: ({ status: state }) => {
            status = nextStatus(status, state);
          },
          onDisconnect: () => {
            status = 'offline';
          },
          /**
           * Кто ещё открыл страницу.
           *
           * Тот же набор, что рисует чужие курсоры: объявляет его расширение
           * курсоров, а читают оба места. Свой номер вкладки спрашивается у
           * канала на каждом изменении — до подключения его нет вовсе, и
           * запомненный однажды оказался бы пустым.
           */
          onAwarenessChange: ({ states }) => {
            onpresence?.(presentPeople(states, connection.awareness?.clientID ?? null));
          },
          /**
           * Служебные сообщения канала.
           *
           * Их три: тело не разобрано, доступ отозван, право правки изменилось.
           * Все три меняют то, что человек видит на экране, и без разбора
           * менялись бы молча — страница оставалась бы открытой на правку у
           * того, у кого её только что отобрали.
           */
          onStateless: ({ payload }) => {
            let message: { type?: string; reason?: string; canEdit?: boolean };
            try {
              message = JSON.parse(payload);
            } catch {
              // Сообщение не наше. Молчать здесь верно: канал общий, и чужое
              // сообщение не повод показывать отказ.
              return;
            }

            if (message?.type === DOCUMENT_UNREADABLE) {
              unreadable = String(message.reason || '');
              setEditable?.(false);
              return;
            }
            if (message?.type === ACCESS_REVOKED) {
              failure = t('You no longer have access to this page.');
              setEditable?.(false);
              return;
            }
            if (message?.type === ACCESS_CHANGED) {
              setEditable?.(editable && message.canEdit !== false);
            }
          },
          /**
           * Отказ службы в подключении: имя документа в адресе не сошлось с
           * именем в протоколе (вкладка открыта до обновления) или права не
           * подтвердились. Сообщение держится состоянием, а не всплывающим
           * окном: исчезнувшее окно оставило бы вкладку мнимо рабочей.
           * Снимается, только если канал позже прошёл проверку.
           */
          onAuthenticationFailed: () => {
            refused = true;
          },
          onAuthenticated: () => {
            refused = false;
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
          pageId: page,
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

        // Содержимое приходит из документа Yjs, а тот собирается из двух
        // источников: сервера и хранилища браузера. Правило засева — в
        // `seedDecision`, там же и причина, почему ждать надо оба.
        let fromServer = false;
        let fromBrowser = false;
        const seed = () => {
          if (made.isDestroyed) return;
          const decision = seedDecision({
            fromServer,
            fromBrowser,
            empty: made.isEmpty,
            content
          });
          if (decision === 'wait') return;
          if (decision === 'seed') {
            try {
              made.commands.setContent(content as never, { emitUpdate: false });
            } catch (error) {
              // Тело написано узлом, которого нет в схеме этой версии. Своя
              // проверка, а не только сообщение канала: сообщение может прийти
              // позже засева, и тогда отказ разбора остался бы незамеченным.
              unreadable = error instanceof Error ? error.message : String(error);
              setEditable?.(false);
            }
          }
          synced = true;
        };

        local.on('synced', () => {
          if (waiting) clearTimeout(waiting);
          waiting = null;
          fromBrowser = true;
          seed();
        });
        waiting = setTimeout(() => {
          waiting = null;
          fromBrowser = true;
          seed();
        }, STORAGE_WAIT);
        connection.on('synced', () => {
          fromServer = true;
          seed();
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
      // Уборка здесь же, а не в `onDestroy`: она нужна и при уходе со
      // страницы, и при переходе на соседнюю. Забытое соединение живёт до
      // перезагрузки вкладки и продолжает получать чужие правки.
      editor?.view.dom.removeEventListener('keydown', keydown, true);
      editor?.destroy();
      provider?.destroy();
      // Хранилище закрывается, а не очищается: набранное без связи обязано
      // пережить и уход со страницы, и закрытие вкладки.
      if (waiting) clearTimeout(waiting);
      waiting = null;
      persistence?.destroy();
      editor = null;
      provider = null;
      persistence = null;
      setEditable = null;
      ready = null;
      suggest = null;
      synced = false;
      status = 'connecting';
      failure = null;
      unreadable = null;
      refused = false;
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
  {#if ready && editable && synced && toolbar}
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
      {#if generative}
        {@render action(IconSparkles, t('Ask AI'), null, () => (asking = !asking))}
      {/if}
    </div>
  {/if}

  {#if failure}
    <p class="mb-2 text-sm text-danger" role="alert">{failure}</p>
  {:else if refused}
    <ConnectionRefused />
  {:else if unreadable}
    <!--
      Тело содержит узел, которого нет в схеме этой версии. Пустой лист вместо
      страницы — худший из возможных ответов: он неотличим от потери текста.
      Здесь называется причина, а ниже показывается сам текст.
    -->
    <div
      data-component="UnreadableDocument"
      class="mb-3 rounded-md border border-border bg-surface-raised p-4"
      role="alert"
    >
      <p class="text-sm font-medium text-danger">
        {t('Some blocks on this page cannot be displayed by this version.')}
      </p>
      <p class="mt-1 text-sm text-text-muted">
        {t('The page is shown as text and cannot be edited. Its content is unchanged.')}
      </p>
    </div>
  {:else if status !== 'ready'}
    <p class="mb-2 text-sm text-text-muted">
      {status === 'offline' ? t('Real-time editor connection lost. Retrying...') : t('Loading...')}
    </p>
  {/if}

  {#if unreadable}
    <div class="tessera-doc mb-4">
      {#each plainText(content) as line, at (at)}
        <p>{line}</p>
      {:else}
        <p class="text-sm text-text-muted">{t('This page is empty')}</p>
      {/each}
    </div>
  {/if}

  {#if ready && editable && synced}
    {#if finding}
      <FindReplace editor={ready} tick={ticks} onclose={() => (finding = false)} />
    {/if}
    {#if toc}
      <Toc editor={ready} tick={ticks} />
    {/if}
    {#if asking && generative}
      <AskAi editor={ready} onclose={() => (asking = false)} />
    {/if}
    {#if inTable}
      <TableMenu editor={ready} />
    {/if}
  {/if}

  <!--
    Пока совместный документ не доехал, показывается содержимое, пришедшее с
    самой страницей. Оно уже на руках, и держать вместо него пустой лист — это
    показывать потерю текста там, где потери нет: при недоступной службе
    редактирования вся вика выглядела бы пустой.
  -->
  {#if !synced && !unreadable}
    <DocumentView {content} />
  {/if}
  <div bind:this={host} hidden={!synced}></div>

  {#if ready && editable && empty}
    <EmptyStart {pageId} onfailure={(message) => (failure = message)} />
  {/if}

  {#if ready && editable && synced}
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
