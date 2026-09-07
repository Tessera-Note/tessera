<script lang="ts">
  import { page as current } from '$app/state';
  import { breadcrumbs, pageTree, type PageSummary } from '$lib/features/page/services/pages';
  import { favoritePageIds } from '$lib/features/page/services/favorites';
  import { listSpaces, type Space } from '$lib/features/space/services/spaces';
  import { onRealtime } from '$lib/features/realtime/socket';
  import { locale } from '$lib/stores/i18n.svelte';
  import PageTreeNode from './PageTreeNode.svelte';

  type Props = { spaceId: string; spaceSlug: string };
  const { spaceId, spaceSlug }: Props = $props();

  let roots = $state<PageSummary[]>([]);
  let loading = $state(true);
  /**
   * Куда можно перенести страницу.
   *
   * Загружается один раз на всё дерево: перечень одинаков для каждой строки, и
   * запрос на строку означал бы сотню одинаковых обращений при раскрытии.
   */
  let spaces = $state<Space[]>([]);

  $effect(() => {
    listSpaces()
      .then((found) => (spaces = found))
      .catch(() => {
        // Отказ перечня прячет перенос, но дерево работает: остальные действия
        // от него не зависят.
        spaces = [];
      });
  });

  /**
   * Отмеченные страницы.
   *
   * Одним перечнем на всё дерево и только идентификаторами: звезда в меню
   * строки спрашивает лишь «отмечено ли», а полный перечень с названиями — это
   * обход прав на каждую строку при каждом открытии пространства.
   */
  let favorites = $state<Set<string>>(new Set());
  let favoriteTick = $state(0);

  $effect(() => {
    void favoriteTick;
    favoritePageIds()
      .then((found) => (favorites = new Set(found)))
      .catch(() => {
        // Отказ гасит звёзды, но не дерево.
        favorites = new Set();
      });
  });
  /**
   * Предки открытой страницы.
   *
   * Дерево не знает, где лежит открытая страница: ветви подгружаются по
   * раскрытию, и в свёрнутом дереве её просто нет. Человек, перешедший по
   * ссылке или по хлебным крошкам, видел слева один корень и не понимал, где
   * находится.
   *
   * Путь спрашивается у сервера теми же хлебными крошками, что рисуются над
   * страницей: второго способа узнать предков у клиента нет, а считать их
   * самому значило бы загружать дерево целиком.
   */
  let ancestors = $state<Set<string>>(new Set());

  $effect(() => {
    // Читается один довод — короткое имя открытой страницы. Всё остальное
    // обработчик только пишет.
    const slug = current.params.pageSlug;
    if (!slug) {
      ancestors = new Set();
      return;
    }
    let dropped = false;
    void breadcrumbs(slug)
      .then((chain) => {
        if (!dropped) ancestors = new Set(chain.map((one) => one.id));
      })
      .catch(() => {
        // Без пути дерево работает как прежде: ветви раскрываются вручную.
      });
    return () => {
      dropped = true;
    };
  });

  //: Счётчик перезапросов. Меняется от события канала, и от него же зависит
  //: загрузка: без него обновление пришлось бы звать в обход своего же кода.
  let refresh = $state(0);

  const t = $derived(locale.t);

  /**
   * Что уже загружено: пространство и счёт перезапросов.
   *
   * Обычными переменными, а не состоянием: эффект их и читает, и пишет, и
   * состояние подписало бы его на собственную запись.
   */
  let loadedSpace: string | null = null;
  let loadedRefresh = -1;

  // Корень перезапрашивается при смене пространства: держать в памяти дерево
  // каждого посещённого пространства значит показывать устаревшее после того,
  // как страницу завели в другой вкладке.
  $effect(() => {
    const wanted = spaceId;
    const tick = refresh;

    // Переход внутри пространства меняет доводы слоя, но не само пространство.
    // Без этой сверки эффект перезапускался на каждое нажатие по дереву, и
    // дерево на сотню миллисекунд пропадало с экрана.
    if (wanted === loadedSpace && tick === loadedRefresh) return;

    const другое = wanted !== loadedSpace;
    loadedSpace = wanted;
    loadedRefresh = tick;

    if (другое) {
      // Строки прежнего пространства к новому не относятся, и показывать их,
      // пока идёт запрос, значило бы выдавать чужое дерево за это.
      roots = [];
      loading = true;
    }

    pageTree(wanted, null)
      .then((found) => {
        if (wanted === loadedSpace) roots = found;
      })
      .catch(() => {
        // Отказ дерева не должен ронять экран: страница открывается по прямой
        // ссылке и без дерева.
        if (wanted === loadedSpace) roots = [];
      })
      .finally(() => {
        if (wanted === loadedSpace) loading = false;
      });
  });

  /**
   * Дерево обновляется от канала событий.
   *
   * Сервер шлёт «перечитай ветвь» на заведение, удаление и перенос страницы:
   * без этого страница, заведённая соседом, появляется у остальных только
   * после перезагрузки, и двое работают с разным деревом.
   */
  $effect(() => {
    return onRealtime((event) => {
      if (event.operation !== 'refetchRootTreeNodeEvent') return;
      if (event.spaceId && event.spaceId !== spaceId) return;
      refresh += 1;
    });
  });
</script>

<div data-component="PageTree" class="space-y-0.5">
  {#if loading}
    <p class="px-2 py-1 text-sm text-text-muted">{t('Loading...')}</p>
  {:else}
    {#each roots as node (node.id)}
      <PageTreeNode
        {node}
        {spaceSlug}
        depth={0}
        activeSlug={current.params.pageSlug}
        {ancestors}
        siblings={roots}
        {spaces}
        {favorites}
        onchanged={() => (refresh += 1)}
        onfavorites={() => (favoriteTick += 1)}
      />
    {:else}
      <p class="px-2 py-1 text-sm text-text-muted">{t('No pages in this space')}</p>
    {/each}
  {/if}
</div>
