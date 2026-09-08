<script lang="ts">
  import { IconArrowsSort, IconFilter, IconPlus, IconX } from '@tabler/icons-svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { BaseProperty } from '../services/bases';
  import type { FilterCondition, FilterOperator, ViewConfig } from '../types';

  type Props = {
    properties: BaseProperty[];
    config: ViewConfig;
    editable: boolean;
    onchange: (config: ViewConfig) => void;
  };
  const { properties, config, editable, onchange }: Props = $props();

  const t = $derived(locale.t);

  /** Действия отбора. Английские подписи — ключи словаря. */
  const OPERATORS: { value: FilterOperator; label: string }[] = [
    { value: 'contains', label: 'Contains' },
    { value: 'ncontains', label: 'Does not contain' },
    { value: 'eq', label: 'Is' },
    { value: 'neq', label: 'Is not' },
    { value: 'startsWith', label: 'Starts with' },
    { value: 'endsWith', label: 'Ends with' },
    { value: 'gt', label: 'Greater than' },
    { value: 'lt', label: 'Less than' },
    { value: 'isEmpty', label: 'Is empty' },
    { value: 'isNotEmpty', label: 'Is not empty' }
  ];

  /**
   * Отбор здесь плоский: перечень условий, соединённых «и» либо «или».
   *
   * Вложенные группы сервер понимает, и разбор их читает (`view.ts`), но
   * заводить их этим экраном нельзя: перечень из двух уровней требует своего
   * устройства показа, а пользы даёт меньше, чем плоский с обоими союзами.
   */
  const conditions = $derived(
    (config.filter?.children ?? []).filter((one): one is FilterCondition => !('children' in one))
  );
  const joiner = $derived(config.filter?.op ?? 'and');

  const propertyOptions = $derived(properties.map((one) => ({ value: one.id, label: one.name })));
  const operatorOptions = $derived(
    OPERATORS.map((one) => ({ value: one.value, label: t(one.label) }))
  );

  function apply(next: FilterCondition[], op: 'and' | 'or' = joiner) {
    onchange({ ...config, filter: next.length ? { op, children: next } : undefined });
  }

  function addCondition() {
    if (properties.length === 0) return;
    apply([...conditions, { propertyId: properties[0].id, op: 'contains', value: '' }]);
  }

  function change(at: number, patch: Partial<FilterCondition>) {
    apply(conditions.map((one, index) => (index === at ? { ...one, ...patch } : one)));
  }

  function drop(at: number) {
    apply(conditions.filter((_, index) => index !== at));
  }

  const sorts = $derived(config.sorts ?? []);

  function applySorts(next: ViewConfig['sorts']) {
    onchange({ ...config, sorts: next?.length ? next : undefined });
  }

  function addSort() {
    if (properties.length === 0) return;
    applySorts([...sorts, { propertyId: properties[0].id, direction: 'asc' }]);
  }
</script>

<div data-component="BaseFilters" class="mb-4 space-y-3 rounded-md border border-border p-3">
  <div class="flex items-center gap-2 text-sm font-medium">
    <IconFilter size={16} stroke={1.7} />
    {t('Filter')}
  </div>

  {#if conditions.length > 1}
    <div class="max-w-24">
      <Select
        value={joiner}
        compact
        disabled={!editable}
        label={t('Join')}
        options={[
          { value: 'and', label: t('All') },
          { value: 'or', label: t('Any') }
        ]}
        onchange={(next) => apply(conditions, next as 'and' | 'or')}
      />
    </div>
  {/if}

  {#each conditions as condition, at (at)}
    <div class="flex flex-wrap items-center gap-2">
      <div class="w-40">
        <Select
          value={condition.propertyId}
          compact
          disabled={!editable}
          label={t('Property')}
          options={propertyOptions}
          onchange={(next) => change(at, { propertyId: next })}
        />
      </div>
      <div class="w-44">
        <Select
          value={condition.op}
          compact
          disabled={!editable}
          label={t('Condition')}
          options={operatorOptions}
          onchange={(next) => change(at, { op: next as FilterOperator })}
        />
      </div>
      {#if condition.op !== 'isEmpty' && condition.op !== 'isNotEmpty'}
        <input
          class="h-7 w-40 rounded border border-border-input bg-surface px-2 text-sm outline-none focus:border-accent"
          value={condition.value === undefined || condition.value === null
            ? ''
            : String(condition.value)}
          disabled={!editable}
          aria-label={t('Value')}
          onchange={(event) =>
            change(at, { value: (event.currentTarget as HTMLInputElement).value })}
        />
      {/if}
      {#if editable}
        <button
          class="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
          type="button"
          aria-label={t('Delete')}
          onclick={() => drop(at)}
        >
          <IconX size={15} stroke={1.7} />
        </button>
      {/if}
    </div>
  {/each}

  {#if editable}
    <button
      class="flex items-center gap-1 text-sm text-text-muted hover:text-text"
      type="button"
      onclick={addCondition}
    >
      <IconPlus size={15} stroke={1.7} />
      {t('Add filter')}
    </button>
  {/if}

  <div class="flex items-center gap-2 border-t border-border pt-3 text-sm font-medium">
    <IconArrowsSort size={16} stroke={1.7} />
    {t('Sort')}
  </div>

  {#each sorts as sort, at (at)}
    <div class="flex flex-wrap items-center gap-2">
      <div class="w-40">
        <Select
          value={sort.propertyId}
          compact
          disabled={!editable}
          label={t('Property')}
          options={propertyOptions}
          onchange={(next) =>
            applySorts(sorts.map((one, i) => (i === at ? { ...one, propertyId: next } : one)))}
        />
      </div>
      <div class="w-32">
        <Select
          value={sort.direction}
          compact
          disabled={!editable}
          label={t('Direction')}
          options={[
            { value: 'asc', label: t('Ascending') },
            { value: 'desc', label: t('Descending') }
          ]}
          onchange={(next) =>
            applySorts(
              sorts.map((one, i) =>
                i === at ? { ...one, direction: next as 'asc' | 'desc' } : one
              )
            )}
        />
      </div>
      {#if editable}
        <button
          class="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
          type="button"
          aria-label={t('Delete')}
          onclick={() => applySorts(sorts.filter((_, i) => i !== at))}
        >
          <IconX size={15} stroke={1.7} />
        </button>
      {/if}
    </div>
  {/each}

  {#if editable}
    <button
      class="flex items-center gap-1 text-sm text-text-muted hover:text-text"
      type="button"
      onclick={addSort}
    >
      <IconPlus size={15} stroke={1.7} />
      {t('Add sort')}
    </button>
  {/if}
</div>
