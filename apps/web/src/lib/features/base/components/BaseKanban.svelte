<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import { cellText, choicesOf, isEmptyCell, type CellContext } from '../cells';
  import { NO_VALUE_CHOICE_ID, type ViewConfig } from '../types';
  import type { BaseProperty, BaseRow } from '../services/bases';

  type Props = {
    properties: BaseProperty[];
    columns: BaseProperty[];
    rows: BaseRow[];
    config: ViewConfig;
    context: CellContext;
    editable: boolean;
    onopen: (row: BaseRow) => void;
    /** Переложить строку в другой столбец: пишется ячейка свойства-группы. */
    onmove: (row: BaseRow, choiceId: string | null) => void;
    onconfig: (config: ViewConfig) => void;
  };
  const { properties, columns, rows, config, context, editable, onopen, onmove, onconfig }: Props =
    $props();

  const t = $derived(locale.t);

  /**
   * По какому свойству раскладывать.
   *
   * Годятся только те, у кого значение из перечня: доска это столбцы, а
   * столбцы берутся из вариантов. По числу или тексту столбцов было бы
   * столько же, сколько строк.
   */
  const groupable = $derived(
    properties.filter((one) => one.type === 'select' || one.type === 'status')
  );
  const groupBy = $derived(
    groupable.find((one) => one.id === config.groupByPropertyId) ?? groupable[0]
  );

  const boardColumns = $derived.by(() => {
    if (!groupBy) return [];
    const hidden = new Set(config.hiddenChoiceIds ?? []);
    const made = choicesOf(groupBy.typeOptions)
      .filter((one) => !hidden.has(one.id))
      .map((one) => ({ key: one.id, name: one.name }));
    // Столбец без значения последним: он не вариант, а его отсутствие.
    return [...made, { key: NO_VALUE_CHOICE_ID, name: t('No value') }];
  });

  function rowsOf(key: string): BaseRow[] {
    if (!groupBy) return [];
    return rows.filter((row) => {
      const value = row.cells[groupBy.id];
      if (key === NO_VALUE_CHOICE_ID) return isEmptyCell(value);
      return String(value) === key;
    });
  }

  /**
   * Что показывать на карточке.
   *
   * Выбранное человеком, а если не выбирал — первые три подряд. Свойство, по
   * которому раскладывают, на карточке не показывается: оно и есть столбец.
   */
  const candidates = $derived(columns.filter((one) => !groupBy || one.id !== groupBy.id));
  const chosen = $derived(config.cardPropertyIds ?? null);
  const preview = $derived(
    chosen ? candidates.filter((one) => chosen.includes(one.id)) : candidates.slice(0, 3)
  );

  /** Открыт перечень свойств карточки. */
  let picking = $state(false);

  function toggleCardProperty(id: string) {
    const current = new Set(chosen ?? candidates.slice(0, 3).map((one) => one.id));
    if (current.has(id)) current.delete(id);
    else current.add(id);
    // Порядок берётся у самих свойств, а не у порядка нажатий: иначе карточки
    // одной доски показывали бы поля в разном порядке у разных людей.
    onconfig({
      ...config,
      cardPropertyIds: candidates.filter((one) => current.has(one.id)).map((one) => one.id)
    });
  }

  let dragged = $state<string | null>(null);

  function drop(key: string) {
    const moved = dragged;
    dragged = null;
    if (!moved) return;
    const row = rows.find((one) => one.id === moved);
    if (!row) return;
    onmove(row, key === NO_VALUE_CHOICE_ID ? null : key);
  }
</script>

{#if !groupBy}
  <p class="rounded-md border border-border p-4 text-sm text-text-muted">
    {t('A board needs a select or status property to group by.')}
  </p>
{:else}
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <span class="text-sm text-text-muted">{t('Group by')}</span>
    <div class="w-48">
      <Select
        value={groupBy.id}
        compact
        disabled={!editable}
        label={t('Group by')}
        options={groupable.map((one) => ({ value: one.id, label: one.name }))}
        onchange={(next) => onconfig({ ...config, groupByPropertyId: next })}
      />
    </div>

    {#if editable && candidates.length > 0}
      <div class="relative">
        <button
          class="rounded border border-border px-2 py-1 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
          type="button"
          aria-expanded={picking}
          onclick={() => (picking = !picking)}
        >
          {t('Card properties')}
        </button>
        {#if picking}
          <!-- Перечень на месте, а не окном: выбор здесь мелкий и частый, а
               окно потребовало бы ловушки фокуса ради трёх флажков. -->
          <div
            class="absolute left-0 z-30 mt-1 w-56 rounded-md border border-border bg-surface-raised p-2 shadow-lg"
          >
            {#each candidates as property (property.id)}
              <label class="flex items-center gap-2 px-1 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={preview.some((one) => one.id === property.id)}
                  onchange={() => toggleCardProperty(property.id)}
                />
                <span class="truncate">{property.name}</span>
              </label>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div data-component="BaseKanban" class="mb-4 flex gap-3 overflow-x-auto pb-2">
    {#each boardColumns as column (column.key)}
      {@const inside = rowsOf(column.key)}
      <div
        class="w-64 shrink-0 rounded-md border border-border bg-surface-raised p-2"
        role="list"
        ondragover={(event) => dragged && event.preventDefault()}
        ondrop={() => drop(column.key)}
      >
        <p class="mb-2 flex items-center justify-between px-1 text-sm font-medium">
          {column.name}
          <span class="text-xs text-text-muted">{inside.length}</span>
        </p>

        {#each inside as row (row.id)}
          <!--
            Карточка это кнопка: она открывает строку, и списочный элемент
            с обработчиком мыши недоступен ни с клавиатуры, ни для чтения
            с экрана.
          -->
          <button
            class="mb-2 block w-full cursor-pointer rounded border border-border bg-surface p-2 text-left text-sm"
            type="button"
            draggable={editable}
            ondragstart={() => (dragged = row.id)}
            ondragend={() => (dragged = null)}
            onclick={() => onopen(row)}
          >
            {#each preview as property, at (property.id)}
              {@const text = cellText(
                row.cells[property.id],
                property.type,
                property.typeOptions,
                context
              )}
              {#if at === 0}
                <p class="truncate font-medium">{text || t('Untitled')}</p>
              {:else if text}
                <p class="truncate text-xs text-text-muted">{property.name}: {text}</p>
              {/if}
            {/each}
          </button>
        {:else}
          <p class="px-1 py-2 text-xs text-text-muted">{t('No rows yet')}</p>
        {/each}
      </div>
    {/each}
  </div>
{/if}
