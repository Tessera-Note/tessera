<script lang="ts">
  import {
    IconEye,
    IconEyeOff,
    IconGripVertical,
    IconSettings,
    IconTrash
  } from '@tabler/icons-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
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
    /** Отмеченные строки. Держит их экран: групповое действие тоже его. */
    selected: string[];
    onwrite: (row: BaseRow, property: BaseProperty, value: unknown) => void;
    onopen: (row: BaseRow) => void;
    ondeleteRow: (row: BaseRow) => void;
    onselect: (rowIds: string[]) => void;
    ondeleteSelected: () => void;
    onconfig: (config: ViewConfig) => void;
    /**
     * Правка свойства. Без неё шестерёнка в шапке не рисуется вовсе.
     *
     * Устройство базы правят на её экране, а не во встроенной таблице: там
     * видна вся база целиком. Пустой обработчик вместо отсутствия оставлял бы
     * на экране кнопку, которая молча ничего не сохраняет.
     */
    onproperty?: (
      property: BaseProperty,
      values: { name?: string; type?: string; typeOptions?: Record<string, unknown> }
    ) => void;
    ondeleteProperty?: (property: BaseProperty) => void;
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
    selected,
    onwrite,
    onopen,
    ondeleteRow,
    onselect,
    ondeleteSelected,
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

  const marked = $derived(new Set(selected));
  const allMarked = $derived(rows.length > 0 && rows.every((one) => marked.has(one.id)));

  /** Строка последнего нажатия: от неё отмеряется отрезок при Shift. */
  let anchor = $state<number | null>(null);

  /**
   * Отметить строку.
   *
   * С Shift отмечается отрезок от прошлого нажатия. Судьбу отрезка решает
   * опорная строка: отмечена она — отмечается весь отрезок, снята — снимается.
   * Так отрезок ведёт себя предсказуемо и при снятии, а не только при выборе.
   */
  function toggleRow(at: number, shift: boolean) {
    const next = new Set(marked);
    if (shift && anchor !== null && anchor !== at) {
      const from = Math.min(anchor, at);
      const to = Math.max(anchor, at);
      const turnOn = marked.has(rows[anchor]?.id ?? '');
      for (let step = from; step <= to; step += 1) {
        const id = rows[step]?.id;
        if (!id) continue;
        if (turnOn) next.add(id);
        else next.delete(id);
      }
    } else {
      const id = rows[at]?.id;
      if (id) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
    }
    anchor = at;
    onselect([...next]);
  }

  /** Отметить всё показанное. Скрытое отбором не трогается: его не видно. */
  function toggleAll() {
    anchor = null;
    onselect(allMarked ? [] : rows.map((one) => one.id));
  }

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

<!-- Выбор колонок меняет настройки представления, а их правит тот, кто правит
     базу. Смотрящему кнопка ничего не даёт: нажатие некуда сохранить. -->
{#if editable}
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
{/if}

{#if picking && editable}
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

<!--
  Полоса группового действия. Показывается только при выборе: постоянная
  строка со счётчиком нуля отнимала бы место у таблицы.
-->
{#if editable && selected.length > 0}
  <div
    data-component="BaseSelection"
    class="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2"
  >
    <span class="flex items-center gap-1 text-sm">
      <IconTrash size={15} stroke={1.7} class="text-text-muted" />
      {t('{{count}} selected', { count: selected.length })}
    </span>
    <Confirm
      label={t('Delete')}
      question={t('Delete {{count}} rows?', { count: selected.length })}
      disabled={busy === 'rows'}
      onconfirm={ondeleteSelected}
    />
    <Button variant="quiet" onclick={() => onselect([])}>{t('Clear selection')}</Button>
  </div>
{/if}

<div class="card-soft mb-4 overflow-x-auto rounded-md border border-border bg-surface-raised">
  <table data-component="BaseTable" class="w-full text-left text-sm">
    <thead class="border-b border-border text-text-muted">
      <tr>
        {#if editable}
          <th class="w-8 p-3">
            <input
              type="checkbox"
              aria-label={t('Select all')}
              checked={allMarked}
              onchange={toggleAll}
            />
          </th>
        {/if}
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
              {#if editable && onproperty}
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

            {#if editingProperty === property.id && onproperty}
              <BasePropertyEditor
                {property}
                busy={busy === property.id}
                onsave={(values) => {
                  onproperty(property, values);
                  editingProperty = null;
                }}
                ondelete={() => {
                  ondeleteProperty?.(property);
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
      {#each rows as row, at (row.id)}
        <tr
          class="border-b border-border last:border-0"
          class:bg-surface-active={marked.has(row.id)}
        >
          {#if editable}
            <td class="p-3">
              <!-- Нажатие с Shift отмечает отрезок, поэтому слушается click, а
                   не change: в change сведений о клавише нет. -->
              <input
                type="checkbox"
                aria-label={t('Select row')}
                checked={marked.has(row.id)}
                onclick={(event) => {
                  event.preventDefault();
                  toggleRow(at, event.shiftKey);
                }}
              />
            </td>
          {/if}
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
              <!-- Строка уходит без возврата, и вопрос здесь обязателен: соседи
                   в этой же ячейке — «Открыть», промах стоит строки. -->
              <Confirm
                label={t('Delete')}
                question={t('Delete record?')}
                disabled={busy === row.id}
                onconfirm={() => ondeleteRow(row)}
              />
            {/if}
          </td>
        </tr>
      {:else}
        <tr>
          <td class="p-3 text-text-muted" colspan={columns.length + (editable ? 2 : 1)}>
            {t('No rows yet')}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
