<script lang="ts">
  import BaseTable from '$lib/features/base/components/BaseTable.svelte';
  import { chooseView, visibleColumns, viewRows, type Column } from '$lib/features/base/view';
  import type { CellContext, PageRef, Person } from '$lib/features/base/cells';
  import type { ViewConfig } from '$lib/features/base/types';
  import {
    baseInfo,
    baseRows,
    createRow,
    deleteRow,
    deleteRows,
    expandPages,
    updateRow,
    updateView,
    type BaseInfo,
    type BaseProperty,
    type BaseRow
  } from '$lib/features/base/services/bases';
  import Button from '$lib/components/ui/Button.svelte';
  import BaseRowCard from '$lib/features/base/components/BaseRowCard.svelte';
  import { errorText } from '$lib/api/failure';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps;
  const { attributes, selected, editable }: Props = $props();

  const t = $derived(locale.t);
  const pageId = $derived(attributes.pageId ? String(attributes.pageId) : null);

  /**
   * База показывается и правится тем же, чем её собственный экран.
   *
   * Не своим рисовальщиком: второй разошёлся бы с первым на первом же новом
   * виде свойства. Права берутся у самой базы — сервер проверяет их снова на
   * каждой записи, но кнопка, которая всегда отказывает, здесь не нужна.
   *
   * Режим чтения страницы правку тоже снимает: страница, открытая на чтение,
   * не должна принимать правку через вставленную в неё базу.
   */
  let base = $state<BaseInfo | null>(null);
  let rows = $state<BaseRow[]>([]);
  let people = $state<Person[]>([]);
  let pages = $state<Record<string, PageRef>>({});
  let failure = $state<string | null>(null);
  let loading = $state(true);
  let busy = $state<string | null>(null);
  /** Какая строка раскрыта карточкой. */
  let opened = $state<string | null>(null);
  /** Отмеченные строки. Имя не `selected`: так зовётся выделение самого узла. */
  let marked = $state<string[]>([]);

  /**
   * Содержимое грузится по требованию и заново при смене базы.
   *
   * Эффект, а не `onMount`: узел живёт внутри документа, а документ
   * пересобирается при переходе на другую страницу.
   */
  $effect(() => {
    const wanted = pageId;
    if (!wanted) return;

    let cancelled = false;
    loading = true;
    failure = null;

    void (async () => {
      try {
        const [info, page] = await Promise.all([baseInfo(wanted), baseRows(wanted)]);
        if (cancelled) return;
        base = info;
        rows = page.items;
        people = page.references?.users ?? [];

        // Названия страниц для ячеек-ссылок сервер отдаёт только по просьбе:
        // права у каждой проверяются отдельно.
        const wantedPages = new Set<string>();
        for (const property of info.properties) {
          if (property.type !== 'page') continue;
          for (const row of page.items) {
            const value = row.cells[property.id];
            for (const one of Array.isArray(value) ? value : [value]) {
              if (typeof one === 'string' && one) wantedPages.add(one);
            }
          }
        }
        if (wantedPages.size > 0) {
          const found = await expandPages([...wantedPages]);
          if (cancelled) return;
          const map: Record<string, PageRef> = {};
          for (const one of found) map[one.id] = one;
          pages = map;
        }
      } catch (error) {
        if (!cancelled) failure = errorText(error, t);
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  // Представление первое из имеющихся: у встроенной базы своего выбора нет,
  // а показывать её вовсе без представления значило бы прятать настроенные
  // людьми отбор и порядок.
  const view = $derived.by(() => {
    if (!base) return null;
    const wanted = chooseView(base.views, null);
    return base.views.find((one) => one.id === wanted) ?? null;
  });
  const config = $derived<ViewConfig>(view?.config ?? {});

  const context = $derived<CellContext>({
    people: Object.fromEntries(people.map((one) => [one.id, one])),
    pages
  });

  const columnsForView = $derived<Column[]>(
    (base?.properties ?? []).map((one) => ({
      id: one.id,
      name: one.name,
      type: one.type,
      position: one.position,
      typeOptions: one.typeOptions,
      isPrimary: one.isPrimary
    }))
  );

  const shownColumns = $derived.by<BaseProperty[]>(() => {
    const order = visibleColumns(columnsForView, config).map((one) => one.id);
    const wanted = new Set(order);
    const found = (base?.properties ?? []).filter((one) => wanted.has(one.id));
    return [...found].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  });

  const shownRows = $derived(viewRows(rows, config, columnsForView, context) as BaseRow[]);
  const openedRow = $derived(rows.find((one) => one.id === opened) ?? null);
  const canEdit = $derived(editable && base?.permissions.canEdit === true);

  /**
   * Перечитать строки после правки.
   *
   * Только строки, а не всю базу: свойства и представления правкой ячейки не
   * меняются, а лишний запрос за ними идёт на каждое нажатие.
   */
  async function refresh() {
    const wanted = pageId;
    if (!wanted) return;
    const page = await baseRows(wanted);
    rows = page.items;
    people = page.references?.users ?? [];
  }

  async function act(key: string, action: () => Promise<unknown>) {
    busy = key;
    failure = null;
    try {
      await action();
      await refresh();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  /**
   * Записать ячейку.
   *
   * Одну, а не строку целиком: слияние делает сервер, и запись всей строки
   * затирала бы правку соседа в соседней ячейке.
   */
  function write(row: BaseRow, property: BaseProperty, value: unknown) {
    if (!pageId) return;
    return act(`${row.id}:${property.id}`, () =>
      updateRow(pageId, row.id, { [property.id]: value })
    );
  }

  function addRow() {
    if (!pageId) return;
    return act('create', () => createRow(pageId));
  }

  function removeRow(row: BaseRow) {
    if (!pageId) return;
    return act(row.id, () => deleteRow(pageId, row.id));
  }

  /** Убрать отмеченные строки. Отметки снимаются только после удачи. */
  function removeMarked() {
    if (!pageId) return;
    const wanted = [...marked];
    if (wanted.length === 0) return;
    return act('rows', async () => {
      await deleteRows(pageId, wanted);
      marked = [];
    });
  }

  /** Настройки представления: сервер пишет `config` как есть. */
  function saveConfig(next: ViewConfig) {
    if (!pageId || !view) return;
    const viewId = view.id;
    return act(viewId, async () => {
      await updateView({ baseId: pageId, viewId, config: next });
      const info = await baseInfo(pageId);
      base = info;
    });
  }
</script>

<!--
  Встроенная база показывается и правится таблицей, как в v1: ссылкой вместо
  неё страница теряет то, ради чего базу в неё и вставили, а уход на отдельный
  экран ради одной ячейки — то же самое другими словами.
-->
<div
  data-component="BaseEmbedView"
  class="my-2 rounded border border-border bg-surface-muted p-3"
  class:outline={selected}
  class:outline-2={selected}
  class:outline-accent={selected}
>
  {#if !pageId}
    <p class="text-sm text-text-muted">{t('Loading...')}</p>
  {:else}
    <a class="mb-2 block text-sm font-medium hover:underline" href="/base/{pageId}">
      {#if base?.icon}<span class="mr-1">{base.icon}</span>{/if}
      {base?.name ?? t('Base')}
    </a>

    {#if failure}
      <p class="text-sm text-danger" role="alert">{failure}</p>
    {:else if loading}
      <p class="text-sm text-text-muted">{t('Loading...')}</p>
    {:else if base}
      <div class="overflow-x-auto">
        <BaseTable
          columns={shownColumns}
          properties={base.properties}
          rows={shownRows}
          {config}
          {context}
          people={people.map((one) => ({ id: one.id, name: one.name }))}
          editable={canEdit}
          pageId={base.id}
          {busy}
          selected={marked}
          onwrite={write}
          onopen={(row) => (opened = row.id)}
          ondeleteRow={removeRow}
          onselect={(rowIds) => (marked = rowIds)}
          ondeleteSelected={removeMarked}
          onconfig={saveConfig}
        />
      </div>

      {#if canEdit}
        <!--
          Строку заводят здесь же. Свойства и представления правятся на экране
          базы: они меняют её устройство, а не содержимое, и место им там, где
          видна вся база целиком.
        -->
        <Button variant="quiet" disabled={busy === 'create'} onclick={addRow}>
          {busy === 'create' ? t('Loading...') : t('New row')}
        </Button>
      {/if}

      {#if openedRow}
        <BaseRowCard
          row={openedRow}
          properties={base.properties}
          {context}
          people={people.map((one) => ({ id: one.id, name: one.name }))}
          editable={canEdit}
          pageId={base.id}
          {busy}
          onwrite={(property, value) => write(openedRow, property, value)}
          ondelete={() => {
            const row = openedRow;
            opened = null;
            if (row) void removeRow(row);
          }}
          onclose={() => (opened = null)}
        />
      {/if}
    {/if}
  {/if}
</div>
