<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Notice from '$lib/components/ui/Notice.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { errorText } from '$lib/api/failure';
  import {
    PROPERTY_TYPES,
    baseRows,
    createProperty,
    createRow,
    createView,
    deleteProperty,
    deleteRow,
    deleteView,
    exportCsv,
    renameBase,
    updateRow,
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

  $effect(() => {
    name = data.base.name ?? '';
    more = [];
    cursor = data.rows.nextCursor;
  });

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

  function cell(row: BaseRow, property: BaseProperty): string {
    const value = row.cells[property.id];
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  /**
   * Записать ячейку.
   *
   * Отправляется одна ячейка, а не строка целиком: слияние делает база, и
   * запись всей строки затирала бы правку соседа в соседней ячейке.
   */
  function write(row: BaseRow, property: BaseProperty, raw: string) {
    const value: unknown =
      property.type === 'number'
        ? raw.trim() === ''
          ? null
          : Number(raw)
        : raw.trim() === ''
          ? null
          : raw;
    if (cell(row, property) === (value === null ? '' : String(value))) return;
    return act(`${row.id}:${property.id}`, () =>
      updateRow(data.base.id, row.id, { [property.id]: value })
    );
  }

  function toggle(row: BaseRow, property: BaseProperty, checked: boolean) {
    return act(`${row.id}:${property.id}`, () =>
      updateRow(data.base.id, row.id, { [property.id]: checked })
    );
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
</script>

<svelte:head><title>{data.base.name ?? t('Untitled')} · Tessera</title></svelte:head>

<section data-route="base" class="mx-auto max-w-5xl">
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

  {#if data.base.views.length > 0 || canEdit}
    <div data-component="BaseViews" class="mb-6 flex flex-wrap items-center gap-2">
      {#each data.base.views as view (view.id)}
        <span class="flex items-center gap-1 rounded bg-surface-raised px-2 py-1 text-sm">
          {view.name}
          {#if canEdit}
            <button
              class="text-text-muted hover:text-text"
              aria-label={t('Delete')}
              onclick={() => act(view.id, () => deleteView(data.base.id, view.id))}
            >
              ×
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
              await createView(data.base.id, newView.trim());
              newView = '';
            });
          }}
        >
          <input
            class="h-8 rounded border border-border-input bg-surface px-2 text-sm text-text outline-none focus:border-accent"
            bind:value={newView}
            placeholder={t('View name')}
          />
          <Button type="submit" disabled={busy === 'view' || !newView.trim()}>{t('Add')}</Button>
        </form>
      {/if}
    </div>
  {/if}

  <div class="mb-4 overflow-x-auto card-soft rounded-md border border-border bg-surface-raised">
    <table data-component="BaseTable" class="w-full text-left text-sm">
      <thead class="border-b border-border text-text-muted">
        <tr>
          {#each data.base.properties as property (property.id)}
            <th class="p-3 font-medium">
              <span class="flex items-center gap-1">
                {property.name}
                {#if canEdit && !property.isPrimary}
                  <button
                    class="text-text-muted hover:text-text"
                    aria-label={t('Delete')}
                    onclick={() =>
                      act(property.id, () => deleteProperty(data.base.id, property.id))}
                  >
                    ×
                  </button>
                {/if}
              </span>
            </th>
          {/each}
          <th class="p-3"></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr class="border-b border-border last:border-0">
            {#each data.base.properties as property (property.id)}
              <td class="p-2">
                {#if property.type === 'checkbox'}
                  <input
                    type="checkbox"
                    checked={row.cells[property.id] === true}
                    disabled={!canEdit}
                    onchange={(event) =>
                      toggle(row, property, (event.currentTarget as HTMLInputElement).checked)}
                  />
                {:else}
                  <input
                    class="w-full rounded border border-transparent bg-transparent px-2 py-1 hover:border-border focus:border-border"
                    value={cell(row, property)}
                    disabled={!canEdit}
                    onchange={(event) =>
                      write(row, property, (event.currentTarget as HTMLInputElement).value)}
                  />
                {/if}
              </td>
            {/each}
            <td class="p-2 text-right">
              {#if canEdit}
                <Button
                  variant="quiet"
                  disabled={busy === row.id}
                  onclick={() => act(row.id, () => deleteRow(data.base.id, row.id))}
                >
                  {t('Delete')}
                </Button>
              {/if}
            </td>
          </tr>
        {:else}
          <tr>
            <td class="p-3 text-text-muted" colspan={data.base.properties.length + 1}>
              {t('No rows yet')}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="mb-8 flex flex-wrap gap-3">
    {#if canEdit}
      <Button disabled={busy === 'row'} onclick={() => act('row', () => createRow(data.base.id))}>
        {t('New row')}
      </Button>
    {/if}
    {#if cursor}
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
      <h2 class="mb-4 text-lg font-medium">{t('Add property')}</h2>
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex-1">
          <span class="mb-1 block text-sm text-text-muted">{t('Name')}</span>
          <TextInput bind:value={newProperty} />
        </label>
        <label>
          <span class="mb-1 block text-sm text-text-muted">{t('Type')}</span>
          <select
            class="rounded border border-border bg-surface px-3 py-2"
            bind:value={newPropertyType}
          >
            {#each PROPERTY_TYPES as one (one.value)}
              <option value={one.value}>{t(one.label)}</option>
            {/each}
          </select>
        </label>
        <Button type="submit" disabled={busy === 'property' || !newProperty.trim()}>
          {t('Add')}
        </Button>
      </div>
    </form>
  {/if}
</section>
