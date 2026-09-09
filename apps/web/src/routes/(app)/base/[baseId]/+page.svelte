<script lang="ts">
  import { untrack } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { IconPlus, IconX } from '@tabler/icons-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
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
    deleteBase,
    deleteProperty,
    deleteRow,
    deleteRows,
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
  /** Открыты ли формы заведения. Обе прячутся за кнопкой панели, как в v1. */
  let addingView = $state(false);
  let addingProperty = $state(false);
  /** Какая строка открыта карточкой. */
  let opened = $state<string | null>(null);
  /** Отмеченные строки. Групповое удаление берёт их отсюда. */
  let selected = $state<string[]>([]);

  $effect(() => {
    name = data.base.name ?? '';
    // Догруженные страницы и отметки снимаются вместе: перечитывание отдаёт
    // первую страницу заново, и отметка на строке из третьей указывала бы на
    // то, чего на экране больше нет.
    more = [];
    selected = [];
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

  /**
   * Свои, ещё не отданные всем настройки отбора и порядка.
   *
   * Представление общее: записанный отбор меняет таблицу у всех, кто её
   * откроет. Человек же чаще всего отбирает для себя — посмотреть свои строки,
   * отсортировать по сроку, — и молчаливая запись такого отбора переставляет
   * таблицу у всей команды. Поэтому правка живёт здесь, а всем уходит
   * отдельным действием, как в v1.
   *
   * `null` означает «своих изменений нет»: показывается общее представление.
   */
  let draft = $state<ViewConfig | null>(null);
  const config = $derived<ViewConfig>(draft ?? view?.config ?? {});
  const changedLocally = $derived(draft !== null);

  $effect(() => {
    // Смена представления и перечитывание страницы сбрасывают своё: настройки
    // относятся к тому представлению, над которым их делали.
    void viewId;
    void data.base.views;
    draft = null;
  });

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
   * Соседи открытой записи в показанном порядке.
   *
   * Именно в показанном, а не в порядке хранения: человек листает то, что
   * видит, и отбор с сортировкой обязаны действовать и здесь.
   */
  const openedAt = $derived(shownRows.findIndex((one) => one.id === opened));
  const previousRow = $derived(openedAt > 0 ? shownRows[openedAt - 1] : null);
  const nextRow = $derived(
    openedAt >= 0 && openedAt < shownRows.length - 1 ? shownRows[openedAt + 1] : null
  );

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

  /**
   * Сохранить название, если оно изменилось.
   *
   * Уходом из поля, а не кнопкой: название правят на месте, и кнопка рядом с
   * заголовком превращала бы экран базы в форму. Пустое имя не сохраняется —
   * база без названия не находится ни в дереве, ни в поиске.
   */
  function renameIfChanged() {
    const wanted = name.trim();
    if (!wanted || wanted === (data.base.name ?? '')) return;
    return act('rename', () => renameBase(data.base.id, wanted));
  }

  /** Правка отбора и порядка. Ложится в своё, а не в общее представление. */
  function saveConfig(next: ViewConfig) {
    draft = next;
  }

  /** Отдать свои настройки всем. Сервер пишет `config` как есть. */
  function publishConfig() {
    if (!view || draft === null) return;
    const wanted = draft;
    return act(view.id, async () => {
      await updateView({ baseId: data.base.id, viewId: view.id, config: wanted });
      await invalidateAll();
      draft = null;
    });
  }

  /**
   * Убрать базу.
   *
   * Уход отсюда обязателен: страница базы к этому времени в корзине, и
   * перечитывание того же адреса дало бы отказ вместо экрана. Перечитывание
   * всё равно нужно — дерево в боковой панели читает список с сервера.
   */
  async function removeBase() {
    busy = 'base';
    failure = null;
    try {
      await deleteBase(data.base.id);
      await goto(data.space ? `/s/${data.space.slug}` : '/home', { invalidateAll: true });
    } catch (error) {
      failure = errorText(error, t);
      busy = null;
    }
  }

  /**
   * Убрать отмеченные строки.
   *
   * Выбор снимается только после удачи: после отказа он ещё нужен — человек
   * повторит то же действие, а не станет отмечать заново.
   */
  function removeSelected() {
    const wanted = [...selected];
    if (wanted.length === 0) return;
    return act('rows', async () => {
      await deleteRows(data.base.id, wanted);
      selected = [];
    });
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

<svelte:head><title>{data.base.name ?? t('Untitled base')} · Tessera</title></svelte:head>

<section data-route="base" class="mx-auto max-w-6xl">
  {#if failure}<Notice message={failure} />{/if}

  <!--
    Название правится на месте и сохраняется уходом из поля, как заголовок
    страницы. Поле с подписью и кнопкой «Сохранить» рядом превращало экран базы
    в форму настроек.
  -->
  <input
    class="mb-4 w-full border-none bg-transparent p-0 text-2xl font-semibold text-text outline-none placeholder:text-text-muted"
    data-component="BaseName"
    bind:value={name}
    disabled={!canEdit}
    aria-label={t('Name')}
    placeholder={t('Untitled base')}
    onblur={renameIfChanged}
    onkeydown={(event) => {
      if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur();
    }}
  />

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
      <!-- Заведение представления прячется за «плюсом»: форма, стоящая рядом с
           вкладками всегда, читается как часть таблицы. -->
      <button
        class="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
        type="button"
        title={t('Add view')}
        aria-label={t('Add view')}
        aria-expanded={addingView}
        onclick={() => (addingView = !addingView)}
      >
        <IconPlus size={16} stroke={1.7} />
      </button>
    {/if}

    <!-- Панель инструментов представления. В v1 это ряд значков над таблицей,
         а не кнопки, расставленные по экрану. -->
    <div class="ml-auto flex items-center gap-1">
      {#if view}
        <button
          class="rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
          class:bg-surface-active={tuning}
          type="button"
          aria-expanded={tuning}
          onclick={() => (tuning = !tuning)}
        >
          {t('Filter and sort')}
        </button>
      {/if}
      {#if canEdit}
        <button
          class="rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
          class:bg-surface-active={addingProperty}
          type="button"
          aria-expanded={addingProperty}
          onclick={() => (addingProperty = !addingProperty)}
        >
          {t('Add property')}
        </button>
      {/if}
      <button
        class="rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
        type="button"
        disabled={busy === 'csv'}
        onclick={() => act('csv', () => exportCsv(data.base.id, `${data.base.name ?? 'base'}.csv`))}
      >
        {t('Export CSV')}
      </button>
      {#if canEdit}
        <!-- Удаление базы стоит последним и с подтверждением: соседство с
             кнопками правки сделало бы промах слишком дешёвым. -->
        <Confirm
          label={t('Delete base')}
          question={t('The base and all its rows will be moved to trash.')}
          disabled={busy === 'base'}
          onconfirm={removeBase}
        />
      {/if}
    </div>
  </div>

  {#if canEdit && addingView}
    <form
      class="mb-4 flex items-center gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        if (!newView.trim()) return;
        return act('view', async () => {
          await createView(data.base.id, newView.trim(), newViewType);
          newView = '';
          addingView = false;
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
      <Button variant="quiet" onclick={() => (addingView = false)}>{t('Cancel')}</Button>
    </form>
  {/if}

  {#if changedLocally}
    <!--
      Свои настройки отбора и порядка. Показываются только тому, кто их сделал,
      пока он не отдаст их всем: представление общее, и молчаливая запись
      переставляла бы таблицу у всей команды.
    -->
    <div
      data-component="BaseLocalConfig"
      class="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-muted px-3 py-2 text-sm"
    >
      <span class="text-text-muted">{t('Filter and sort changes are visible only to you')}</span>
      {#if canEdit}
        <Button variant="quiet" disabled={busy === view?.id} onclick={publishConfig}>
          {t('Save for everyone')}
        </Button>
      {/if}
      <Button variant="quiet" onclick={() => (draft = null)}>{t('Discard')}</Button>
    </div>
  {/if}

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
      pageId={data.base.id}
      onfail={(error) => (failure = errorText(error, t))}
      {busy}
      {selected}
      onwrite={write}
      onopen={(row) => (opened = row.id)}
      ondeleteRow={(row) => act(row.id, () => deleteRow(data.base.id, row.id))}
      onselect={(rowIds) => (selected = rowIds)}
      ondeleteSelected={removeSelected}
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
      <Button
        variant="quiet"
        disabled={busy === 'row'}
        onclick={() => act('row', () => createRow(data.base.id))}
      >
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
  </div>

  {#if canEdit && addingProperty}
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
          addingProperty = false;
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
      pageId={data.base.id}
      onfail={(error) => (failure = errorText(error, t))}
      {busy}
      onprevious={previousRow ? () => (opened = previousRow.id) : null}
      onnext={nextRow ? () => (opened = nextRow.id) : null}
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
