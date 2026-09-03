<script lang="ts">
  import { IconChevronLeft, IconChevronRight } from '@tabler/icons-svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import { cellText, type CellContext } from '../cells';
  import type { ViewConfig } from '../types';
  import type { BaseProperty, BaseRow } from '../services/bases';

  type Props = {
    properties: BaseProperty[];
    columns: BaseProperty[];
    rows: BaseRow[];
    config: ViewConfig;
    context: CellContext;
    editable: boolean;
    onopen: (row: BaseRow) => void;
    onconfig: (config: ViewConfig) => void;
  };
  const { properties, columns, rows, config, context, editable, onopen, onconfig }: Props =
    $props();

  const t = $derived(locale.t);

  /** По какому свойству раскладывать. Годятся только даты. */
  const datable = $derived(
    properties.filter(
      (one) => one.type === 'date' || one.type === 'createdAt' || one.type === 'lastEditedAt'
    )
  );
  const dateBy = $derived(datable.find((one) => one.id === config.datePropertyId) ?? datable[0]);

  /** Какой месяц показан. Отдельным состоянием: настройка это не месяц. */
  let shown = $state(new Date());

  const month = $derived(shown.getMonth());
  const year = $derived(shown.getFullYear());

  /**
   * Сетка месяца: полные недели с понедельника.
   *
   * Дни соседних месяцев показываются приглушённо — без них первая и последняя
   * неделя обрываются, и день недели у чисел перестаёт совпадать с колонкой.
   */
  const grid = $derived.by(() => {
    const first = new Date(year, month, 1);
    // В `getDay` воскресенье это ноль: сдвигаем к понедельнику.
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - offset);

    const days: Date[] = [];
    for (let at = 0; at < 42; at += 1) {
      days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + at));
    }
    return days;
  });

  /** Ключ дня в местном времени: `toISOString` сместил бы дату часовым поясом. */
  function dayKey(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  const byDay = $derived.by(() => {
    const map = new Map<string, BaseRow[]>();
    if (!dateBy) return map;

    for (const row of rows) {
      const raw = row.cells[dateBy.id];
      if (raw === null || raw === undefined || raw === '') continue;
      const when = new Date(String(raw));
      if (Number.isNaN(when.getTime())) continue;
      const key = dayKey(when);
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return map;
  });

  const titleProperty = $derived(columns[0]);

  const weekdays = $derived.by(() => {
    // Названия дней берутся у самого языка: свой список означал бы двенадцать
    // списков и порядок, который где-нибудь начинается с воскресенья.
    const made: string[] = [];
    for (let at = 0; at < 7; at += 1) {
      const day = new Date(2026, 0, 5 + at); // 5 января 2026 — понедельник
      made.push(day.toLocaleDateString(locale.current, { weekday: 'short' }));
    }
    return made;
  });
</script>

{#if !dateBy}
  <p class="rounded-md border border-border p-4 text-sm text-text-muted">
    {t('A calendar needs a date property.')}
  </p>
{:else}
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <button
      class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
      type="button"
      aria-label={t('Previous')}
      onclick={() => (shown = new Date(year, month - 1, 1))}
    >
      <IconChevronLeft size={17} stroke={1.7} />
    </button>
    <span class="min-w-40 text-center text-sm font-medium">
      {shown.toLocaleDateString(locale.current, { month: 'long', year: 'numeric' })}
    </span>
    <button
      class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
      type="button"
      aria-label={t('Next')}
      onclick={() => (shown = new Date(year, month + 1, 1))}
    >
      <IconChevronRight size={17} stroke={1.7} />
    </button>

    <span class="ml-4 text-sm text-text-muted">{t('Date property')}</span>
    <div class="w-48">
      <Select
        value={dateBy.id}
        compact
        disabled={!editable}
        label={t('Date property')}
        options={datable.map((one) => ({ value: one.id, label: one.name }))}
        onchange={(next) => onconfig({ ...config, datePropertyId: next })}
      />
    </div>
  </div>

  <div
    data-component="BaseCalendar"
    class="card-soft mb-4 overflow-hidden rounded-md border border-border bg-surface-raised"
  >
    <div class="grid grid-cols-7 border-b border-border text-xs text-text-muted">
      {#each weekdays as day (day)}
        <span class="p-2 text-center">{day}</span>
      {/each}
    </div>
    <div class="grid grid-cols-7">
      {#each grid as day (day.getTime())}
        {@const inside = byDay.get(dayKey(day)) ?? []}
        <div
          class="min-h-24 border-b border-r border-border p-1 last:border-r-0"
          class:opacity-50={day.getMonth() !== month}
        >
          <p class="mb-1 text-xs text-text-muted">{day.getDate()}</p>
          {#each inside as row (row.id)}
            <button
              class="mb-1 block w-full truncate rounded bg-accent-soft px-1 py-0.5 text-left text-xs text-accent"
              type="button"
              onclick={() => onopen(row)}
            >
              {titleProperty
                ? cellText(
                    row.cells[titleProperty.id],
                    titleProperty.type,
                    titleProperty.typeOptions,
                    context
                  ) || t('Untitled')
                : t('Untitled')}
            </button>
          {/each}
        </div>
      {/each}
    </div>
  </div>
{/if}
