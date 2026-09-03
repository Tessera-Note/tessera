<script lang="ts">
  import { IconEye, IconEyeOff, IconGripVertical, IconSettings } from '@tabler/icons-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import BaseCell from './BaseCell.svelte';
  import BasePropertyEditor from './BasePropertyEditor.svelte';
  import type { CellContext } from '../cells';
  import type { BaseProperty, BaseRow } from '../services/bases';
  import type { ViewConfig } from '../types';

  type Props = {
    columns: BaseProperty[];
    /** Все свойства базы: перечень видимости показывает и скрытые. */
    properties: BaseProperty[];
    rows: BaseRow[];
    config: ViewConfig;
    context: CellContext;
    people: { id: string; name: string | null }[];
    editable: boolean;
    busy: string | null;
    onwrite: (row: BaseRow, property: BaseProperty, value: unknown) => void;
    onopen: (row: BaseRow) => void;
    ondeleteRow: (row: BaseRow) => void;
    onconfig: (config: ViewConfig) => void;
    onproperty: (
      property: BaseProperty,
      values: { name?: string; type?: string; typeOptions?: Record<string, unknown> }
    ) => void;
    ondeleteProperty: (property: BaseProperty) => void;
  };
  const {
    columns,
    properties,
    rows,
    config,
    context,
    people,
    editable,
    busy,
    onwrite,
    onopen,
    ondeleteRow,
    onconfig,
    onproperty,
    ondeleteProperty
  }: Props = $props();

  const t = $derived(locale.t);

  /** Какое свойство правят. Пусто — окно закрыто. */
  let editingProperty = $state<string | null>(null);
  /** Открыт перечень видимости колонок. */
  let picking = $state(false);
  /** Какую колонку тащат. */
  let dragged = $state<string | null>(null);

  const hidden = $derived(new Set(config.hiddenPropertyIds ?? []));

  function toggleColumn(id: string) {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onconfig({ ...config, hiddenPropertyIds: [...next] });
  }

  /**
   * Переставить колонку.
   *
   * Порядок хранится перечнем имён в настройках представления, а не позицией
   * свойства: у свойства позиция одна на базу, а порядок колонок свой у
   * каждого представления.
   */
  function drop(target: string) {
    const moved = dragged;
    dragged = null;
    if (!moved || moved === target) return;

    const order = columns.map((one) => one.id).filter((one) => one !== moved);
    const at = order.indexOf(target);
    order.splice(at < 0 ? order.length : at, 0, moved);
    onconfig({ ...config, propertyOrder: order });
  }
</script>

<div class="mb-2 flex items-center gap-2">
  <button
    class="flex items-center gap-1 rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
    type="button"
    aria-expanded={picking}
    onclick={() => (picking = !picking)}
  >
    <IconEye size={16} stroke={1.7} />
    {t('Columns')}
  </button>
</div>

{#if picking}
  <div class="mb-3 flex flex-wrap gap-2 rounded-md border border-border p-3">
    {#each properties as property (property.id)}
      {@const shown = property.isPrimary || !hidden.has(property.id)}
      <button
        class="flex items-center gap-1 rounded border px-2 py-1 text-xs"
        class:border-accent={shown}
        class:text-accent={shown}
        class:border-border={!shown}
        class:text-text-muted={!shown}
        type="button"
        disabled={property.isPrimary || !editable}
        aria-pressed={shown}
        onclick={() => toggleColumn(property.id)}
      >
        {#if shown}<IconEye size={14} stroke={1.7} />{:else}<IconEyeOff
            size={14}
            stroke={1.7}
          />{/if}
        {property.name}
      </button>
    {/each}
  </div>
{/if}

<div class="card-soft mb-4 overflow-x-auto rounded-md border border-border bg-surface-raised">
  <table data-component="BaseTable" class="w-full text-left text-sm">
    <thead class="border-b border-border text-text-muted">
      <tr>
        {#each columns as property (property.id)}
          <th
            class="relative p-3 font-medium"
            draggable={editable}
            ondragstart={() => (dragged = property.id)}
            ondragover={(event) => dragged && event.preventDefault()}
            ondrop={() => drop(property.id)}
          >
            <span class="flex items-center gap-1">
              {#if editable}
                <IconGripVertical size={14} stroke={1.7} class="cursor-grab text-text-muted" />
              {/if}
              {property.name}
              {#if editable}
                <button
                  class="text-text-muted hover:text-text"
                  type="button"
                  aria-label={t('Edit property')}
                  onclick={() =>
                    (editingProperty = editingProperty === property.id ? null : property.id)}
                >
                  <IconSettings size={14} stroke={1.7} />
                </button>
              {/if}
            </span>

            {#if editingProperty === property.id}
              <BasePropertyEditor
                {property}
                busy={busy === property.id}
                onsave={(values) => {
                  onproperty(property, values);
                  editingProperty = null;
                }}
                ondelete={() => {
                  ondeleteProperty(property);
                  editingProperty = null;
                }}
                onclose={() => (editingProperty = null)}
              />
            {/if}
          </th>
        {/each}
        <th class="p-3"></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.id)}
        <tr class="border-b border-border last:border-0">
          {#each columns as property (property.id)}
            <td class="p-2">
              <BaseCell
                {property}
                value={row.cells[property.id]}
                {context}
                {people}
                {editable}
                onwrite={(value) => onwrite(row, property, value)}
              />
            </td>
          {/each}
          <td class="whitespace-nowrap p-2 text-right">
            <Button variant="quiet" onclick={() => onopen(row)}>{t('Open')}</Button>
            {#if editable}
              <Button variant="quiet" disabled={busy === row.id} onclick={() => ondeleteRow(row)}>
                {t('Delete')}
              </Button>
            {/if}
          </td>
        </tr>
      {:else}
        <tr>
          <td class="p-3 text-text-muted" colspan={columns.length + 1}>{t('No rows yet')}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
