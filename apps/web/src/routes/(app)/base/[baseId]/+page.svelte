<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { IconPlus, IconX } from '@tabler/icons-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import BaseCalendar from '$lib/features/base/components/BaseCalendar.svelte';
  import BaseFilters from '$lib/features/base/components/BaseFilters.svelte';
  import BaseKanban from '$lib/features/base/components/BaseKanban.svelte';
  import BaseRowCard from '$lib/features/base/components/BaseRowCard.svelte';
  import BaseTable from '$lib/features/base/components/BaseTable.svelte';
  import { chooseView, visibleColumns, viewRows, type Column } from '$lib/features/base/view';
  import type { CellContext, PageRef, Person } from '$lib/features/base/cells';
  import type { ViewConfig } from '$lib/features/base/types';
  import {
    PROPERTY_TYPES,
    VIEW_TYPES,
    baseRows,
    createProperty,
    createRow,
    createView,
    deleteProperty,
    deleteRow,
    deleteView,
    expandPages,
    exportCsv,
    renameBase,
    updateProperty,
    updateRow,
    updateView,
    type BaseProperty,
    type BaseRow
  } from '$lib/features/base/services/bases';
  import { onRealtime, sendRealtime } from '$lib/features/realtime/socket';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { PageData } from './$types';

  type Props = { data: PageData };
  const { data }: Props = $props();

  const t = $derived(locale.t);
  const canEdit = $derived(data.base.permissions.canEdit);

  let busy = $state<string | null>(null);
  let failure = $state<string | null>(null);

  /** Догруженные строки: сервер отдаёт их страницами по позиции. */
  let more = $state<BaseRow[]>([]);
  let cursor = $state<string | null>(null);
  const rows = $derived([...data.rows.items, ...more]);

  let name = $state('');
  let newProperty = $state('');
  let newPropertyType = $state('text');
  let newView = $state('');
  let newViewType = $state('table');

  /** Какое представление открыто. Пусто — таблица без настроек. */
  let viewId = $state<string | null>(null);
  /** Открыты настройки отбора и порядка. */
  let tuning = $state(false);
  /** Какая строка открыта карточкой. */
  let opened = $state<string | null>(null);

  $effect(() => {
    name = data.base.name ?? '';
    more = [];
    cursor = data.rows.nextCursor;
    // Представление выбирается первым из имеющихся: показывать базу вовсе без
    // представления значило бы прятать настроенные людьми отбор и порядок.
    // Своё же значение читается вне отслеживания: эффект его пишет, и подписка
    // на него зациклила бы правку.
    viewId = chooseView(
      data.base.views,
      untrack(() => viewId)
    );
  });

  const view = $derived(data.base.views.find((one) => one.id === viewId) ?? null);
  const config = $derived<ViewConfig>(view?.config ?? {});

  /**
   * Люди для ячеек с человеком.
   *
   * Два источника, и оба нужны. Вместе со строками сервер разворачивает только
   * авторов правок — их он и так читает. В ячейке же может стоять кто угодно
   * из пространства, поэтому его участники загружаются отдельно; они же
   * составляют перечень выбора.
   */
  const people = $derived(
    data.members.map((one) => ({ id: one.id, name: one.name, avatarUrl: null }))
  );
  const peopleById = $derived.by(() => {
    const map: Record<string, Person> = {};
    for (const one of data.rows.references?.users ?? []) map[one.id] = one;
    for (const one of people) map[one.id] = map[one.id] ?? one;
    return map;
  });

  /**
   * Названия страниц для ячеек со ссылками.
   *
   * Отдельным запросом: сервер отдаёт их только по просьбе, и права у каждой
   * проверяются отдельно — ячейка может ссылаться на закрытую страницу.
   */
  let pagesById = $state<Record<string, PageRef>>({});

  $effect(() => {
    const wanted = new Set<string>();
    for (const property of data.base.properties) {
      if (property.type !== 'page') continue;
      for (const row of rows) {
        const value = row.cells[property.id];
        for (const one of Array.isArray(value) ? value : [value]) {
          if (typeof one === 'string' && one) wanted.add(one);
        }
      }
    }
    if (wanted.size === 0) {
      pagesById = {};
      return;
    }

    void expandPages([...wanted])
      .then((found) => {
        const map: Record<string, PageRef> = {};
        for (const one of found) map[one.id] = one;
        pagesById = map;
      })
      .catch(() => {
        // Отказ разворота не должен ронять таблицу: ячейка покажет
        // идентификатор вместо названия.
        pagesById = {};
      });
  });

  const context = $derived<CellContext>({ people: peopleById, pages: pagesById });

  /** Свойства в виде, который понимает отбор. */
  const columnsForView = $derived<Column[]>(
    data.base.properties.map((one) => ({
      id: one.id,
      name: one.name,
      type: one.type,
      position: one.position,
      typeOptions: one.typeOptions,
      isPrimary: one.isPrimary
    }))
  );

  const shownColumns = $derived.by(() => {
    const wanted = new Set(visibleColumns(columnsForView, config).map((one) => one.id));
    const order = visibleColumns(columnsForView, config).map((one) => one.id);
    const found = data.base.properties.filter((one) => wanted.has(one.id));
    return [...found].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  });

  const shownRows = $derived(viewRows(rows, config, columnsForView, context) as BaseRow[]);
  const openedRow = $derived(rows.find((one) => one.id === opened) ?? null);

  /**
   * База обновляется от канала событий.
   *
   * Подписка отдельная: комнаты базы сервер заводит по просьбе, а не при
   * подключении — рассылать правки строк всем, кто состоит в пространстве,
   * означало бы слать их тем, кто базу не открывал.
   */
  $effect(() => {
    const pageId = data.base.id;
    void sendRealtime({ operation: 'base:subscribe', pageId });

    const stop = onRealtime((event) => {
      const kind = String(event.operation ?? '');
      if (!kind.startsWith('base:')) return;
      if (event.pageId && event.pageId !== pageId) return;
      // Правка приходит уже применённой к базе: перечитывается страница
      // целиком, а не патчится состояние. Сшивать своё состояние с чужими
      // правками значило бы держать вторую копию правил слияния.
      void invalidateAll();
    });

    return () => {
      void sendRealtime({ operation: 'base:unsubscribe', pageId });
      stop();
    };
  });

  async function act(key: string, action: () => Promise<unknown>) {
    busy = key;
    failure = null;
    try {
      await action();
      await invalidateAll();
    } catch (error) {
      failure = errorText(error, t);
    } finally {
      busy = null;
    }
  }

  /**
   * Записать ячейку.
   *
   * Отправляется одна ячейка, а не строка целиком: слияние делает база, и
   * запись всей строки затирала бы правку соседа в соседней ячейке.
   */
  function write(row: BaseRow, property: BaseProperty, value: unknown) {
    return act(`${row.id}:${property.id}`, () =>
      updateRow(data.base.id, row.id, { [property.id]: value })
    );
  }

  /** Сохранить настройки представления целиком: сервер пишет `config` как есть. */
  function saveConfig(next: ViewConfig) {
    if (!view) return;
    return act(view.id, () => updateView({ baseId: data.base.id, viewId: view.id, config: next }));
  }

  async function loadMore() {
    if (!cursor) return;
    try {
      const next = await baseRows(data.base.id, cursor);
      more = [...more, ...next.items];
      cursor = next.nextCursor;
    } catch (error) {
      failure = errorText(error, t);
    }
  }

  const propertyTypes = $derived(
    PROPERTY_TYPES.map((one) => ({ value: one.value, label: t(one.label) }))
  );
  const viewTypes = $derived(VIEW_TYPES.map((one) => ({ value: one.value, label: t(one.label) })));
</script>

<svelte:head><title>{data.base.name ?? t('Untitled')} · Tessera</title></svelte:head>

<section data-route="base" class="mx-auto max-w-6xl">
  {#if failure}<Notice message={failure} />{/if}

  <div class="mb-6 flex items-end gap-3">
    <label class="flex-1">
      <span class="mb-1 block text-sm text-text-muted">{t('Name')}</span>
      <TextInput bind:value={name} disabled={!canEdit} />
    </label>
    {#if canEdit}
      <Button
        disabled={busy === 'rename' || !name.trim()}
        onclick={() => act('rename', () => renameBase(data.base.id, name.trim()))}
      >
        {t('Save')}
      </Button>
    {/if}
  </div>

  <div data-component="BaseViews" class="mb-4 flex flex-wrap items-center gap-2">
    {#each data.base.views as one (one.id)}
      <span
        class="flex items-center gap-1 rounded px-2 py-1 text-sm"
        class:bg-surface-active={one.id === viewId}
        class:bg-surface-raised={one.id !== viewId}
      >
        <button type="button" onclick={() => (viewId = one.id)}>{one.name}</button>
        {#if canEdit}
          <button
            class="text-text-muted hover:text-text"
            type="button"
            aria-label={t('Delete')}
            onclick={() => act(one.id, () => deleteView(data.base.id, one.id))}
          >
            <IconX size={14} stroke={1.7} />
          </button>
        {/if}
      </span>
    {/each}

    {#if canEdit}
      <form
        class="flex items-center gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          if (!newView.trim()) return;
          return act('view', async () => {
            await createView(data.base.id, newView.trim(), newViewType);
            newView = '';
          });
        }}
      >
        <input
          class="h-8 rounded border border-border-input bg-surface px-2 text-sm text-text outline-none focus:border-accent"
          bind:value={newView}
          placeholder={t('View name')}
        />
        <div class="w-32">
          <Select bind:value={newViewType} compact label={t('Type')} options={viewTypes} />
        </div>
        <Button type="submit" disabled={busy === 'view' || !newView.trim()}>{t('Add')}</Button>
      </form>
    {/if}

    {#if view}
      <button
        class="ml-auto rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
        type="button"
        aria-expanded={tuning}
        onclick={() => (tuning = !tuning)}
      >
        {t('Filter and sort')}
      </button>
    {/if}
  </div>

  {#if view && tuning}
    <BaseFilters
      properties={data.base.properties}
      {config}
      editable={canEdit}
      onchange={saveConfig}
    />
  {/if}

  {#if view?.type === 'kanban'}
    <BaseKanban
      properties={data.base.properties}
      columns={shownColumns}
      rows={shownRows}
      {config}
      {context}
      editable={canEdit}
      onopen={(row) => (opened = row.id)}
      onmove={(row, choiceId) => {
        const groupBy = data.base.properties.find(
          (one) => one.id === (config.groupByPropertyId ?? '')
        );
        const property =
          groupBy ??
          data.base.properties.find((one) => one.type === 'select' || one.type === 'status');
        if (property) write(row, property, choiceId);
      }}
      onconfig={saveConfig}
    />
  {:else if view?.type === 'calendar'}
    <BaseCalendar
      properties={data.base.properties}
      columns={shownColumns}
      rows={shownRows}
      {config}
      {context}
      editable={canEdit}
      onopen={(row) => (opened = row.id)}
      onconfig={saveConfig}
    />
  {:else}
    <BaseTable
      columns={shownColumns}
      properties={data.base.properties}
      rows={shownRows}
      {config}
      {context}
      {people}
      editable={canEdit}
      {busy}
      onwrite={write}
      onopen={(row) => (opened = row.id)}
      ondeleteRow={(row) => act(row.id, () => deleteRow(data.base.id, row.id))}
      onconfig={saveConfig}
      onproperty={(property, values) =>
        act(property.id, () =>
          updateProperty({ baseId: data.base.id, propertyId: property.id, ...values })
        )}
      ondeleteProperty={(property) =>
        act(property.id, () => deleteProperty(data.base.id, property.id))}
    />
  {/if}

  <div class="mb-8 flex flex-wrap gap-3">
    {#if canEdit}
      <Button disabled={busy === 'row'} onclick={() => act('row', () => createRow(data.base.id))}>
        {t('New row')}
      </Button>
    {/if}
    {#if cursor}
      <!--
        Отбор и порядок считаются по загруженным строкам: движка отбора на
        стороне сервера нет, и незагруженное в них не попадает.
      -->
      <Button variant="quiet" onclick={loadMore}>{t('Load more')}</Button>
    {/if}
    <Button
      variant="quiet"
      disabled={busy === 'csv'}
      onclick={() => act('csv', () => exportCsv(data.base.id, `${data.base.name ?? 'base'}.csv`))}
    >
      {t('Export CSV')}
    </Button>
  </div>

  {#if canEdit}
    <form
      class="card-soft rounded-md border border-border bg-surface-raised p-5"
      onsubmit={(event) => {
        event.preventDefault();
        if (!newProperty.trim()) return;
        return act('property', async () => {
          await createProperty({
            baseId: data.base.id,
            name: newProperty.trim(),
            type: newPropertyType
          });
          newProperty = '';
        });
      }}
    >
      <h2 class="mb-4 flex items-center gap-2 text-lg font-medium">
        <IconPlus size={18} stroke={1.7} />
        {t('Add property')}
      </h2>
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex-1">
          <span class="mb-1 block text-sm text-text-muted">{t('Name')}</span>
          <TextInput bind:value={newProperty} />
        </label>
        <label>
          <span class="mb-1 block text-sm text-text-muted">{t('Type')}</span>
          <Select bind:value={newPropertyType} label={t('Type')} options={propertyTypes} />
        </label>
        <Button type="submit" disabled={busy === 'property' || !newProperty.trim()}>
          {t('Add')}
        </Button>
      </div>
    </form>
  {/if}

  {#if openedRow}
    <BaseRowCard
      row={openedRow}
      properties={data.base.properties}
      {context}
      {people}
      editable={canEdit}
      {busy}
      onwrite={(property, value) => write(openedRow, property, value)}
      ondelete={() =>
        act(openedRow.id, async () => {
          await deleteRow(data.base.id, openedRow.id);
          opened = null;
        })}
      onclose={() => (opened = null)}
    />
  {/if}
</section>
