<script lang="ts">
  import { untrack } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import {
    IconBell,
    IconBellOff,
    IconCheck,
    IconCopy,
    IconEdit,
    IconEye,
    IconFileExport,
    IconFolderSymlink,
    IconLayoutSidebarRight,
    IconMessage,
    IconLink,
    IconMoodSmile,
    IconPrinter,
    IconStar,
    IconStarFilled,
    IconTemplate,
    IconTrash,
    IconTrashX,
    IconX
  } from '@tabler/icons-svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Editor from '$lib/features/editor/Editor.svelte';
  import Breadcrumbs from '$lib/components/page/Breadcrumbs.svelte';
  import PageTitle from '$lib/components/page/PageTitle.svelte';
  import PagePresence from '$lib/components/page/PagePresence.svelte';
  import PageSidePanel from '$lib/components/page/PageSidePanel.svelte';
  import { ApiError } from '$lib/api/client';
  import { errorText } from '$lib/api/failure';
  import { editModeGate } from '$lib/features/page/edit-mode';
  import { wantsToolbar, wantsWidePage } from '$lib/features/user/services/profile';
  import { sidePanel } from '$lib/features/page/side-panel.svelte';
  import { addFavorite, removeFavorite } from '$lib/features/page/services/favorites';
  import EmojiPicker from '$lib/features/editor/EmojiPicker.svelte';
  import PageExport from '$lib/components/page/PageExport.svelte';
  import {
    deletePage,
    duplicatePage,
    movePageToSpace,
    unwatchPage,
    updatePage,
    watchPage
  } from '$lib/features/page/services/pages';
  import { onRealtime } from '$lib/features/realtime/socket';
  import { createTemplate } from '$lib/features/template/services/templates';
  import { downloadPdf, exportPagePdf, listFileTasks } from '$lib/features/page/services/pdf';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { Present } from '$lib/features/editor/presence';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  const canEdit = $derived(data.page.canEdit !== false);

  /**
   * Вправе ли смотрящий писать в обсуждение.
   *
   * То же правило, что проверяет сервер: пишущий — всегда, читатель — только
   * при включённой настройке пространства.
   */
  const canComment = $derived(canEdit || data.space?.allowViewerComments === true);

  /** С чего открывается страница. Правило и его оговорки — в `edit-mode.ts`. */
  let editing = $state(false);
  const gate = editModeGate();

  $effect(() => {
    const decided = gate.decide(
      data.page.id,
      canEdit,
      // Свой выбор сильнее общего: умолчание рабочего пространства для тех,
      // кто своего не делал, и только для них.
      data.session?.user.settings?.preferences?.pageEditMode ??
        data.session?.workspace.defaultPageEditMode
    );
    if (decided !== null) editing = decided;
  });

  /** Лист во всю ширину. Личная настройка, умолчание — узкий лист. */
  const wide = $derived(wantsWidePage(data.session?.user.settings?.preferences));

  /**
   * Цвет чужого курсора.
   *
   * Выводится из идентификатора, а не назначается случайно: при переподключении
   * цвет должен остаться прежним, иначе один и тот же человек мигает разными.
   */
  function caretColor(seed: string): string {
    let sum = 0;
    for (const one of seed) sum = (sum * 31 + one.charCodeAt(0)) % 360;
    return `hsl(${sum} 70% 55%)`;
  }

  /** Счёт слов и знаков. Приходит от редактора: считает он, показывает панель. */
  let stats = $state<{ words: number; characters: number } | null>(null);

  /**
   * Кто ещё открыл эту страницу.
   *
   * Приходит от редактора: сведения объявляются в канале совместного
   * редактирования, и там же берёт их расширение чужих курсоров. Второй
   * источник расходился бы с курсорами в тексте.
   */
  let present = $state<Present[]>([]);

  let busy = $state(false);
  let failure = $state<string | null>(null);

  async function act(action: () => Promise<unknown>) {
    busy = true;
    failure = null;
    try {
      await action();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  /**
   * Название страницы, каким его видит этот экран.
   *
   * Держится отдельно от `data`, потому что меняется двумя путями: своей
   * правкой и событием о чужой. Без местного состояния чужое переименование
   * доходило бы только перезагрузкой, а сохранение поверх затирало бы его.
   */
  let heading = $state<string | null>(null);
  /** Значок страницы. Меняется теми же двумя путями, что и название. */
  let badge = $state<string | null>(null);
  $effect(() => {
    heading = data.page.title ?? null;
    badge = data.page.icon ?? null;
  });

  /**
   * Чужое переименование приходит событием и обновляет поле.
   *
   * Название живёт вне совместного документа: правки текста сходятся сами, а
   * название сохраняется обычным запросом. Раньше двое, открывшие одну
   * страницу, держали каждый своё, и побеждал сохранивший последним — молча.
   */
  $effect(() => {
    return onRealtime((event) => {
      if (event.operation !== 'page:heading:updated') return;
      if (event.pageId !== data.page.id) return;
      heading = (event.title as string | null) ?? null;
      badge = (event.icon as string | null) ?? null;
    });
  });

  const rename = (title: string) =>
    act(async () => {
      // Серверу отдаётся то название, которое видел правящий: если за это
      // время его сменил другой, правка будет отвергнута, а не затрёт чужую.
      await updatePage({
        pageId: data.page.id,
        title,
        expectedTitle: heading ?? ''
      });
      heading = title;
      // Название видно и в дереве, и в хлебных крошках: перечитать надо всё.
      await invalidateAll();
    });

  const toggleFavorite = () =>
    act(async () => {
      await (data.favorite ? removeFavorite(data.page.id) : addFavorite(data.page.id));
      await invalidateAll();
    });

  /** Подписка на страницу. Состояние приходит с сервера и меняется здесь же. */
  let watching = $state(false);
  $effect(() => {
    watching = data.watching?.isWatching ?? false;
  });

  const toggleWatch = () =>
    act(async () => {
      const status = data.watching?.isWatching
        ? await unwatchPage(data.page.id)
        : await watchPage(data.page.id);
      watching = status.isWatching;
      await invalidateAll();
    });

  /** Копия страницы с ветвью. Ложится рядом, в то же пространство. */
  const duplicate = () =>
    act(async () => {
      const copy = await duplicatePage(data.page.id);
      await goto(`/s/${data.space?.slug ?? ''}/p/${copy.slugId}`);
      await invalidateAll();
    });

  /** Открыт перечень пространств для переноса. */
  let moving = $state(false);

  const moveToSpace = (spaceId: string) =>
    act(async () => {
      await movePageToSpace(data.page.id, spaceId);
      moving = false;
      const target = data.spaces.find((one) => one.id === spaceId);
      await goto(`/s/${target?.slug ?? ''}/p/${data.page.slugId}`);
      await invalidateAll();
    });

  /** Открыто окно выгрузки. */
  let exporting = $state(false);

  /** Открыт выбор значка страницы. */
  let choosing = $state(false);

  const setIcon = (icon: string) =>
    act(async () => {
      await updatePage({ pageId: data.page.id, icon });
      badge = icon;
      choosing = false;
      // Значок виден и в дереве, и в хлебных крошках: перечитать надо всё.
      await invalidateAll();
    });

  /**
   * Снять значок.
   *
   * Пустой строкой, а не отсутствием поля: сервер отличает «не передавали» от
   * «очистить», и без явного пустого значения значок остался бы прежним.
   */
  const clearIcon = () =>
    act(async () => {
      await updatePage({ pageId: data.page.id, icon: '' });
      badge = null;
      choosing = false;
      await invalidateAll();
    });

  let savedTemplate = $state(false);
  /** Задание печати: пока оно идёт, человеку сообщается, что оно идёт. */
  let printing = $state(false);

  /**
   * Отправить страницу на печать.
   *
   * Печатает браузер на стороне сервера, и это занимает время: ответ приходит
   * заданием, а не файлом. Готовый документ забирается по его идентификатору.
   */
  const exportPdf = (includeChildren: boolean) =>
    act(async () => {
      printing = true;
      try {
        const task = await exportPagePdf({ pageId: data.page.id, includeChildren });
        await waitForPdf(task.fileTaskId);
      } finally {
        printing = false;
      }
    });

  async function waitForPdf(fileTaskId: string): Promise<void> {
    // Опрос, а не ожидание одного ответа: печать ветви занимает десятки секунд,
    // и держать запрос всё это время нельзя.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((done) => setTimeout(done, 1000));
      const tasks = await listFileTasks();
      const task = tasks.items.find((one) => one.id === fileTaskId);
      if (!task) continue;
      if (task.status === 'failed') {
        throw new ApiError(400, 'error.pdf_export.export_not_found', task.errorMessage ?? '', {});
      }
      if (task.status === 'success') {
        await downloadPdf(fileTaskId, task.fileName);
        return;
      }
    }
    throw new ApiError(408, 'error.pdf_export.export_is_not_ready_yet', '', {});
  }

  /**
   * Сохранить страницу шаблоном.
   *
   * Область — пространство страницы, а не рабочее пространство: страница
   * писалась под своё пространство, и предлагать её всем по умолчанию значит
   * навязывать чужой порядок.
   */
  const saveAsTemplate = () =>
    act(async () => {
      savedTemplate = false;
      await createTemplate({
        title: data.page.title ?? t('Untitled'),
        icon: data.page.icon ?? undefined,
        content: data.page.content,
        spaceId: data.page.spaceId
      });
      savedTemplate = true;
    });

  /**
   * Удаление спрашивает второй раз.
   *
   * Значок стоит в ряду с девятью такими же, и промах по соседнему уносил
   * страницу без вопроса. Удаление мягкое, но возвращать из корзины —
   * отдельная работа, а в v1 здесь стоит окно с подтверждением. Спрашивается
   * на месте, а не окном: окну нужна ловушка фокуса и выход по Escape, то есть
   * куда больше кода ради того же одного вопроса.
   */
  let removing = $state(false);

  const remove = () =>
    act(async () => {
      // Удаление мягкое: страница уходит в корзину, откуда её возвращают.
      await deletePage(data.page.id);
      await invalidateAll();
      await goto(`/s/${data.space?.slug ?? ''}`);
    });

  /**
   * Ссылка на страницу в буфер.
   *
   * Адрес отдаёт сам браузер: приложение развёртывают и на своём домене, и на
   * `localhost`, и вписанный в настройки адрес расходился бы с тем, по
   * которому человек сейчас работает.
   */
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 2000);
    } catch {
      // Буфер недоступен: браузер не дал права. Показывать нечего.
    }
  }

  $effect(() => () => {
    if (copyTimer) clearTimeout(copyTimer);
  });

  /**
   * Печать страницы средствами браузера.
   *
   * Отдельно от вывоза в PDF: тот собирается на сервере и приходит файлом, а
   * печать нужна тогда, когда лист нужен сейчас и в руки. Так же в v1.
   */
  function print() {
    // Задержка, как в v1: окно печати снимает разметку сразу, и без неё
    // всплывающие подсказки попадают на лист.
    setTimeout(() => window.print(), 250);
  }

  $effect(() => {
    sidePanel.hydrate();
  });

  /**
   * Какую вкладку панели открыть.
   *
   * Панель одна, а поводов её открыть два: посмотреть обсуждение и посмотреть
   * сведения о странице. Кнопка задаёт место, иначе человек попадает туда, где
   * был в прошлый раз.
   */
  /**
   * Переход на другую страницу закрывает открытое и снимает взведённое.
   *
   * Маршрут один на все страницы пространства, и состояние экрана переход
   * переживает: взведённое «удалить» оставалось взведённым на новой странице,
   * открытое окно вывоза относилось уже к другому документу, а извещение об
   * удавшемся действии — к прежнему.
   *
   * Вкладка панели намеренно не сбрасывается: человек выбрал, что смотреть, и
   * при переходе он смотрит то же самое у соседней страницы.
   */
  $effect(() => {
    void data.page.id;
    untrack(() => {
      moving = false;
      exporting = false;
      choosing = false;
      savedTemplate = false;
      removing = false;
      copied = false;
      failure = null;
      // Счёт слов принадлежит документу: до пересборки редактора он от
      // прежнего, и показывать его как счёт новой страницы нельзя.
      stats = null;
    });
  });

  let panelTab = $state<string | null>(null);

  /**
   * Ссылка на отдельную реплику.
   *
   * Довод адреса ставит `/c/<реплика>`, который знает только идентификатор
   * реплики, но не страницу. Здесь он открывает обсуждение и подсвечивает ту
   * самую реплику: без этого ссылка приводила на страницу целиком.
   */
  const anchored = $derived(page.url.searchParams.get('comment'));

  $effect(() => {
    if (!anchored) return;
    untrack(() => {
      panelTab = 'comments';
      if (!sidePanel.open) sidePanel.toggle();
    });
  });

  function openPanel(wanted: string) {
    if (sidePanel.open && panelTab === wanted) {
      sidePanel.toggle();
      return;
    }
    panelTab = wanted;
    if (!sidePanel.open) sidePanel.toggle();
  }
</script>

<svelte:head><title>{data.page.title ?? t('Untitled')} · Tessera</title></svelte:head>

<!-- Отступ под правую панель только там, где она отодвигает содержимое: на
     узком экране она лежит поверх, и отступ оставлял бы пустую полосу. -->
<div class:lg:mr-aside={sidePanel.open}>
  <!--
    Ширина листа — личная настройка человека («Полная ширина страницы» в
    настройках чтения). Она сохранялась, но нигде не применялась: переключатель
    стоял и не делал ничего. В v1 её применяет тот же лист
    (`features/editor/full-editor.tsx`).
  -->
  <article data-route="page" class="mx-auto" class:max-w-3xl={!wide}>
    <!--
      Полоса действий закреплена сверху, как в v1
      (`features/page/components/header/page-header.module.css`). Раньше крошки
      и действия были обычными строками содержимого: на длинной странице до них
      нельзя было добраться, не прокрутив её до самого верха.
    -->
    <div
      data-component="PageBar"
      class="sticky top-header z-10 -mx-4 mb-6 flex min-h-header flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border bg-surface px-4 py-1 sm:h-header sm:flex-nowrap sm:py-0 print:hidden"
    >
      <Breadcrumbs crumbs={data.crumbs} spaceSlug={data.space?.slug ?? ''} />

      <!--
        Действия значками, как в v1: шесть подписей подряд забирают половину
        ширины и читаются как перечень, а не как действия. Подпись остаётся во
        всплывающей и в имени для чтения с экрана.
      -->
      <div class="relative flex shrink-0 items-center gap-0.5">
        <IconButton
          icon={copied ? IconCheck : IconLink}
          label={copied ? t('Copied') : t('Copy link')}
          onclick={copyLink}
        />
        <IconButton
          icon={data.favorite ? IconStarFilled : IconStar}
          label={data.favorite ? t('Remove from favorites') : t('Add to favorites')}
          disabled={busy}
          onclick={toggleFavorite}
        />
        <!-- Подписка отдельно от избранного: избранное это своя закладка,
             подписка — извещения о чужих правках. -->
        <IconButton
          icon={watching ? IconBell : IconBellOff}
          label={watching ? t('Unsubscribe') : t('Subscribe')}
          active={watching}
          disabled={busy}
          onclick={toggleWatch}
        />
        {#if canEdit}
          <IconButton
            icon={editing ? IconEye : IconEdit}
            label={editing ? t('Read') : t('Edit')}
            active={editing}
            onclick={() => (editing = !editing)}
          />
          <IconButton
            icon={IconTemplate}
            label={t('New template')}
            disabled={busy}
            onclick={saveAsTemplate}
          />
          <IconButton icon={IconPrinter} label={t('Print PDF')} onclick={print} />
          <IconButton
            icon={IconFileExport}
            label={t('Export')}
            active={exporting}
            disabled={busy}
            onclick={() => (exporting = !exporting)}
          />
          <IconButton icon={IconCopy} label={t('Duplicate')} disabled={busy} onclick={duplicate} />
          <IconButton
            icon={IconFolderSymlink}
            label={t('Move to space')}
            active={moving}
            disabled={busy}
            onclick={() => (moving = !moving)}
          />
          {#if removing}
            <!--
              Подтверждение и отказ рядом. Срока у вопроса нет намеренно: он
              снимался сам, и кнопка под курсором молча меняла смысл с
              «подтвердить» обратно на «удалить».
            -->
            <IconButton
              icon={IconTrashX}
              label={t('Confirm')}
              active
              disabled={busy}
              onclick={() => {
                removing = false;
                void remove();
              }}
            />
            <IconButton icon={IconX} label={t('Cancel')} onclick={() => (removing = false)} />
          {:else}
            <IconButton
              icon={IconTrash}
              label={t('Delete')}
              disabled={busy}
              onclick={() => (removing = true)}
            />
          {/if}
        {/if}

        <!-- Обсуждение открывается своей кнопкой, как в v1: панель одна, а
             попадать в неё надо на нужное место. -->
        <IconButton
          icon={IconMessage}
          label={t('Comments')}
          active={sidePanel.open && panelTab === 'comments'}
          onclick={() => openPanel('comments')}
        />
        <IconButton
          icon={IconLayoutSidebarRight}
          label={t('Details')}
          active={sidePanel.open && panelTab !== 'comments'}
          onclick={() => openPanel('history')}
        />

        {#if exporting}
          <PageExport
            pageId={data.page.id}
            title={data.page.title ?? t('Untitled')}
            onpdf={exportPdf}
            onclose={() => (exporting = false)}
          />
        {/if}

        {#if moving}
          <div
            class="absolute right-0 top-10 z-40 max-h-64 w-56 overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
            role="menu"
          >
            {#each data.spaces.filter((one) => one.id !== data.page.spaceId) as space (space.id)}
              <button
                class="w-full truncate px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
                type="button"
                role="menuitem"
                disabled={busy}
                onclick={() => moveToSpace(space.id)}
              >
                {space.name}
              </button>
            {:else}
              <p class="px-3 py-1.5 text-sm text-text-muted">{t('No spaces yet')}</p>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <h1 class="relative mb-6 flex items-start gap-2">
      {#if canEdit}
        <!-- Значок страницы это эмодзи в самой странице, а не файл: так же
             в v1, и дерево показывает его без второго запроса. -->
        <button
          class="mt-0.5 shrink-0 rounded text-3xl leading-tight hover:bg-surface-hover"
          type="button"
          title={t('Choose icon')}
          aria-label={t('Choose icon')}
          aria-expanded={choosing}
          onclick={() => (choosing = !choosing)}
        >
          {#if data.page.icon}
            <span aria-hidden="true">{data.page.icon}</span>
          {:else}
            <IconMoodSmile size={26} stroke={1.6} />
          {/if}
        </button>
        {#if choosing}
          <EmojiPicker
            current={badge}
            onpick={setIcon}
            onclear={clearIcon}
            onclose={() => (choosing = false)}
          />
        {/if}
      {:else if badge}
        <span class="shrink-0 text-3xl leading-tight" aria-hidden="true">{badge}</span>
      {/if}

      <PageTitle
        title={heading}
        editable={canEdit && editing}
        onsave={rename}
        onleave={() => document.querySelector<HTMLElement>('.tiptap')?.focus()}
      />
    </h1>

    {#if failure}<Notice message={failure} />{/if}
    {#if savedTemplate}<Notice tone="info" message={t('Template created successfully')} />{/if}

    <!--
      Один и тот же редактор и на чтение, и на правку. Второй рисовальщик для
      чтения показывал бы страницу иначе: картинки, метки состояния и перечни
      подстраниц он не знает, и они пропадали бы при выходе из правки.

      Соединение канала открывается и на чтении: правка соседа видна сразу, а не
      после перезагрузки.
    -->
    <Editor
      pageId={data.page.id}
      content={data.page.content}
      editable={canEdit && editing}
      author={{
        id: data.session?.user.id ?? null,
        name: data.session?.user.name ?? data.session?.user.email ?? '',
        color: caretColor(data.session?.user.id ?? ''),
        avatarUrl: data.session?.user.avatarUrl ?? null
      }}
      userId={data.session?.user.id}
      spaceId={data.page.spaceId}
      toolbar={wantsToolbar(data.session?.user.settings?.preferences)}
      generative={data.session?.workspace.aiGenerativeEnabled !== false}
      oncount={(counted) => (stats = counted)}
      onpresence={(people) => (present = people)}
    />

    <!-- Внизу листа, а не в заголовке: заголовок занят действиями над
         страницей, и присутствие там читалось бы как ещё одна кнопка. -->
    <PagePresence people={present} />
  </article>

  {#if sidePanel.open}
    <PageSidePanel
      pageId={data.page.id}
      spaceId={data.page.spaceId}
      versions={data.versions}
      labels={data.labels}
      backlinkCount={data.backlinkCount}
      permission={data.permission}
      verification={data.verification}
      share={data.share}
      spaceSlug={data.space?.slug ?? ''}
      {stats}
      createdAt={data.page.createdAt ?? null}
      updatedAt={data.page.updatedAt ?? null}
      comments={data.comments}
      content={data.page.content}
      {canComment}
      userId={data.session?.user.id}
      want={panelTab}
      highlight={anchored}
      onclose={() => sidePanel.toggle()}
    />
  {/if}
</div>
