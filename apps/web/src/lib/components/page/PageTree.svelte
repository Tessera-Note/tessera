<script lang="ts">
  import { page as current } from '$app/state';
  import { breadcrumbs, pageTree, type PageSummary } from '$lib/features/page/services/pages';
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

  // Корень перезапрашивается при смене пространства: держать в памяти дерево
  // каждого посещённого пространства значит показывать устаревшее после того,
  // как страницу завели в другой вкладке.
  $effect(() => {
    const wanted = spaceId;
    void refresh;
    loading = true;
    pageTree(wanted, null)
      .then((found) => {
        if (wanted === spaceId) roots = found;
      })
      .catch(() => {
        // Отказ дерева не должен ронять экран: страница открывается по прямой
        // ссылке и без дерева.
        if (wanted === spaceId) roots = [];
      })
      .finally(() => {
        if (wanted === spaceId) loading = false;
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
        onchanged={() => (refresh += 1)}
      />
    {:else}
      <p class="px-2 py-1 text-sm text-text-muted">{t('No pages in this space')}</p>
    {/each}
  {/if}
</div>
