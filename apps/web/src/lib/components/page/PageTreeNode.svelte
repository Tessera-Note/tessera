<script lang="ts">
  import { untrack } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { IconDots } from '@tabler/icons-svelte';
  import { errorText } from '$lib/api/failure';
  import { drag } from '$lib/features/page/drag.svelte';
  import { zoneAt } from '$lib/features/page/drop-zone';
  import { placeBetween } from '$lib/features/page/order-key.placement';
  import {
    createPage,
    deletePage,
    duplicatePage,
    movePage,
    movePageToSpace,
    pageTree,
    type PageSummary
  } from '$lib/features/page/services/pages';
  import type { Space } from '$lib/features/space/services/spaces';
  import { locale } from '$lib/stores/i18n.svelte';
  import PageMenu from './PageMenu.svelte';
  import PageTreeNode from './PageTreeNode.svelte';

  type Props = {
    node: PageSummary;
    spaceSlug: string;
    depth: number;
    activeSlug: string | undefined;
    /**
     * Предки открытой страницы. Ветвь, попавшая сюда, раскрывается сама:
     * иначе открытой страницы в свёрнутом дереве просто нет, и человек не
     * видит, где находится.
     */
    ancestors: Set<string>;
    /** Соседи по ветви: по ним считается ключ порядка при перестановке. */
    siblings: PageSummary[];
    /** Куда можно перенести страницу. Перечень общий на всё дерево. */
    spaces: Space[];
    /** Перечитать ветвь родителя после переноса или удаления. */
    onchanged: () => void;
  };
  const { node, spaceSlug, depth, activeSlug, ancestors, siblings, spaces, onchanged }: Props =
    $props();

  let open = $state(false);
  let children = $state<PageSummary[] | null>(null);
  let loading = $state(false);
  let menu = $state(false);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let row: HTMLDivElement | undefined = $state();

  const t = $derived(locale.t);

  /**
   * Ветвь загружается при первом раскрытии, а не вместе с деревом.
   *
   * Дерево вики бывает в тысячи страниц, и загрузка целиком означает мегабайт
   * ответа ради десятка видимых строк. Повторное раскрытие берёт уже
   * загруженное: перезапрос на каждый щелчок мигал бы содержимым.
   */
  async function toggle() {
    open = !open;
    if (!open || children !== null) return;
    await load();
  }

  async function load() {
    loading = true;
    try {
      children = await pageTree(node.spaceId, node.id);
    } catch {
      // Отказ ветви не должен ронять дерево: остальные ветви работают.
      children = [];
    } finally {
      loading = false;
    }
  }

  /**
   * Раскрыться, если открытая страница лежит внутри.
   *
   * Читается один довод — перечень предков. `open` и `children` обработчик
   * только пишет, и читает их через `untrack`: эффект, прочитавший то, что сам
   * записал, подписывается на собственную запись, и Svelte снимает ветвь.
   *
   * Свёрнутое вручную не раскрывается заново само: перечень предков меняется
   * только при переходе на другую страницу.
   */
  $effect(() => {
    const wanted = ancestors;
    if (!wanted.has(node.id)) return;
    if (untrack(() => open)) return;
    open = true;
    if (untrack(() => children) === null) void load();
  });

  /**
   * Показать открытую строку.
   *
   * Раскрытия мало: в дереве на тысячу страниц нужная строка оказывается за
   * пределами окна, и человек по-прежнему её не видит. Прокрутка мягкая и
   * ближайшая — резкая перестановка списка читается как сбой.
   */
  $effect(() => {
    const mine = activeSlug === node.slugId;
    const target = row;
    if (!mine || !target) return;
    target.scrollIntoView({ block: 'nearest' });
  });

  /** Перечитать свою ветвь: после правки внутри неё. */
  async function reload() {
    if (children !== null || open) await load();
  }

  async function act(action: () => Promise<unknown>) {
    busy = true;
    failure = null;
    menu = false;
    try {
      await action();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = false;
    }
  }

  const addSubpage = () =>
    act(async () => {
      const made = await createPage({ spaceId: node.spaceId, parentPageId: node.id });
      open = true;
      await load();
      await goto(`/s/${spaceSlug}/p/${made.slugId}`);
    });

  const duplicate = () =>
    act(async () => {
      await duplicatePage(node.id);
      onchanged();
    });

  const moveToSpace = (spaceId: string) =>
    act(async () => {
      await movePageToSpace(node.id, spaceId);
      onchanged();
      // Страница уехала: открытая, она осталась бы на экране под чужим
      // пространством в адресе.
      if (activeSlug === node.slugId) await invalidateAll();
    });

  const remove = () =>
    act(async () => {
      await deletePage(node.id);
      onchanged();
    });

  /**
   * Бросок страницы на эту строку.
   *
   * Три исхода по месту указателя: перед строкой, после неё и внутрь неё.
   * Ключ порядка считается по соседям того списка, куда страница встаёт, — и
   * соседям, у которых ключа ещё не было, он сперва раздаётся: положение
   * «между двумя без ключа» выразить нечем.
   */
  function drop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    const moved = drag.pageId;
    const zone = drag.zone;
    drag.end();
    if (!moved || moved === node.id) return;

    void act(async () => {
      if (zone === 'inside') {
        const inside = children ?? (await pageTree(node.spaceId, node.id));
        const spot = placeBetween(
          inside.filter((one) => one.id !== moved),
          inside.length
        );
        for (const one of spot.prepare) await movePage({ pageId: one.id, position: one.position });
        await movePage({ pageId: moved, parentPageId: node.id, position: spot.position });
        open = true;
        await load();
        onchanged();
        return;
      }

      // Сама переставляемая страница из соседей исключается: иначе она
      // считалась бы соседом самой себе и вставала бы не туда, откуда её взяли.
      const list = siblings.filter((one) => one.id !== moved);
      const at = list.findIndex((one) => one.id === node.id);
      const spot = placeBetween(list, zone === 'before' ? at : at + 1);
      for (const one of spot.prepare) await movePage({ pageId: one.id, position: one.position });
      await movePage({
        pageId: moved,
        position: spot.position,
        parentPageId: node.parentPageId ?? undefined,
        detach: node.parentPageId === null
      });
      onchanged();
    });
  }

  function dragover(event: DragEvent) {
    if (!drag.pageId || drag.pageId === node.id) return;
    event.preventDefault();
    event.stopPropagation();
    const box = row?.getBoundingClientRect();
    drag.over(node.id, box ? zoneAt(event.clientY - box.top, box.height) : 'inside');
  }

  const highlighted = $derived(drag.overId === node.id && drag.pageId !== node.id);
</script>

<!--
  Отступ ветви задаётся шагом, а не глубиной.

  Дочерние строки лежат внутри родительской, и её отступ они уже получили.
  Отступ по глубине складывался с родительским, и на восьмом уровне ветвь
  уходила за край панели: у строк оставался значок, а название сжималось в
  ничто. Найдено на ввезённой выгрузке, где такая глубина обычна.
-->
<div data-component="PageTreeNode" style="padding-left: {depth === 0 ? 0 : 12}px">
  <div
    bind:this={row}
    class="group relative flex items-center gap-1 rounded"
    class:bg-surface-active={highlighted && drag.zone === 'inside'}
    class:border-t-2={highlighted && drag.zone === 'before'}
    class:border-b-2={highlighted && drag.zone === 'after'}
    class:border-accent={highlighted && drag.zone !== 'inside'}
    role="treeitem"
    tabindex="-1"
    aria-selected={activeSlug === node.slugId}
    aria-expanded={node.hasChildren === false ? undefined : open}
    draggable={node.canEdit !== false}
    ondragstart={() => drag.start(node.id)}
    ondragend={() => drag.end()}
    ondragover={dragover}
    ondragleave={() => drag.overId === node.id && drag.over('', 'inside')}
    ondrop={drop}
  >
    {#if node.hasChildren === false}
      <!-- Значка раскрытия у листа нет: он раскрывался бы в пустоту. Место
           под него остаётся, иначе строки уезжают влево и дерево рябит. -->
      <span class="w-5 shrink-0" aria-hidden="true"></span>
    {:else}
      <button
        class="w-5 shrink-0 rounded text-xs text-text-muted hover:bg-surface-muted"
        type="button"
        aria-label={open ? t('Collapse') : t('Expand')}
        aria-expanded={open}
        onclick={toggle}
      >
        {open ? '▾' : '▸'}
      </button>
    {/if}

    <a
      class="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-sm hover:bg-surface-muted"
      class:font-medium={activeSlug === node.slugId}
      href="/s/{spaceSlug}/p/{node.slugId}"
    >
      <span aria-hidden="true">{node.icon ?? '📄'}</span>
      {node.title ?? t('Untitled')}
    </a>

    <button
      class="shrink-0 rounded px-1 text-text-muted opacity-0 hover:bg-surface-muted group-hover:opacity-100 focus:opacity-100"
      type="button"
      aria-label={t('Page options')}
      aria-haspopup="menu"
      aria-expanded={menu}
      disabled={busy}
      onclick={(event) => {
        event.stopPropagation();
        menu = !menu;
      }}
    >
      <IconDots size={16} stroke={1.7} />
    </button>

    {#if menu}
      <PageMenu
        canEdit={node.canEdit !== false}
        {spaces}
        spaceId={node.spaceId}
        {busy}
        onsubpage={addSubpage}
        onduplicate={duplicate}
        onmove={moveToSpace}
        ondelete={remove}
        onclose={() => (menu = false)}
      />
    {/if}
  </div>

  {#if failure}
    <p class="py-1 pl-8 text-xs text-danger" role="alert">{failure}</p>
  {/if}

  {#if open}
    {#if loading}
      <p class="py-1 pl-8 text-xs text-text-muted">{t('Loading...')}</p>
    {:else if children && children.length > 0}
      {#each children as child (child.id)}
        <PageTreeNode
          node={child}
          {spaceSlug}
          depth={depth + 1}
          {activeSlug}
          {ancestors}
          siblings={children}
          {spaces}
          onchanged={reload}
        />
      {/each}
    {:else}
      <p class="py-1 pl-8 text-xs text-text-muted">{t('No pages inside')}</p>
    {/if}
  {/if}
</div>
