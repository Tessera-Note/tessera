<script lang="ts">
  import { untrack } from 'svelte';
  import { IconPlus, IconX } from '@tabler/icons-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import TextInput from '$lib/components/ui/TextInput.svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import { choicesOf } from '../cells';
  import { PROPERTY_TYPES, type BaseProperty } from '../services/bases';
  import type { Choice } from '../types';

  type Props = {
    property: BaseProperty;
    busy: boolean;
    onsave: (values: {
      name?: string;
      type?: string;
      typeOptions?: Record<string, unknown>;
    }) => void;
    ondelete: () => void;
    onclose: () => void;
  };
  const { property, busy, onsave, ondelete, onclose }: Props = $props();

  const t = $derived(locale.t);

  // Поля заводятся тем, что стоит сейчас, и дальше живут сами: окно правки
  // открывается заново на каждое свойство, следить за доводом незачем.
  let name = $state(untrack(() => property.name));
  let type = $state<string>(untrack(() => property.type));
  let choices = $state<Choice[]>(untrack(() => choicesOf(property.typeOptions)));

  /** Настройки вида. Читаются один раз, дальше правятся полями окна. */
  const saved = untrack(() => (property.typeOptions ?? {}) as Record<string, unknown>);
  let numberFormat = $state(String(saved.format ?? 'plain'));
  let precision = $state(saved.precision === undefined ? '' : String(saved.precision));
  let separator = $state(String(saved.separator ?? 'comma-period'));
  let currency = $state(String(saved.currency ?? 'USD'));
  let includeTime = $state(saved.includeTime === true);
  let timeFormat = $state(String(saved.timeFormat ?? '24'));
  let defaultChecked = $state(saved.defaultValue === true);
  let allowMultiple = $state(saved.allowMultiple === true);
  let alphabetize = $state(saved.alphabetize === true);
  let formulaSource = $state(String(saved.source ?? ''));

  const NUMBER_FORMATS = [
    { value: 'plain', label: 'Plain' },
    { value: 'currency', label: 'Currency' },
    { value: 'percent', label: 'Percent' }
  ];
  const SEPARATORS = [
    { value: 'comma-period', label: 'Comma, period' },
    { value: 'period-comma', label: 'Period, comma' },
    { value: 'space-comma', label: 'Space, comma' },
    { value: 'space-period', label: 'Space, period' }
  ];
  const TIME_FORMATS = [
    { value: '24', label: '24-hour' },
    { value: '12', label: '12-hour' }
  ];

  const typeOptions = $derived(
    PROPERTY_TYPES.map((one) => ({ value: one.value, label: t(one.label) }))
  );

  /** Виды, у которых значение выбирают из перечня. */
  const withChoices = $derived(type === 'select' || type === 'status' || type === 'multiSelect');

  function addChoice() {
    // Имя варианта короткое и случайное: оно ложится в каждую ячейку, а не
    // хранится один раз, и полный UUID раздувал бы каждую строку.
    choices = [...choices, { id: crypto.randomUUID().slice(0, 8), name: '' }];
  }

  /**
   * Настройки вида для сохранения.
   *
   * Собираются по виду свойства, а не все разом: настройка числа у даты
   * означала бы поле, которого человек не задавал, и следующая правка вернула
   * бы его на место.
   */
  function options(): Record<string, unknown> {
    const values: Record<string, unknown> = { ...(property.typeOptions ?? {}) };

    if (withChoices) {
      const kept = choices.filter((one) => one.name.trim());
      values.choices = kept;
      values.choiceOrder = kept.map((one) => one.id);
      values.alphabetize = alphabetize;
    }
    if (type === 'number') {
      values.format = numberFormat;
      values.separator = separator;
      values.precision = precision.trim() === '' ? undefined : Number(precision);
      values.currency = numberFormat === 'currency' ? currency.trim().toUpperCase() : undefined;
    }
    if (type === 'date') {
      values.includeTime = includeTime;
      values.timeFormat = includeTime ? timeFormat : undefined;
    }
    if (type === 'checkbox') values.defaultValue = defaultChecked;
    if (type === 'person') values.allowMultiple = allowMultiple;
    if (type === 'formula') values.source = formulaSource;

    // Пустые значения убираются: сохранённое `undefined` уходит в JSON ключом
    // без значения и мешает сверке «менялось ли».
    for (const [key, one] of Object.entries(values)) if (one === undefined) delete values[key];
    return values;
  }

  function save() {
    const values: { name?: string; type?: string; typeOptions?: Record<string, unknown> } = {};
    if (name.trim() && name !== property.name) values.name = name.trim();
    if (type !== property.type) values.type = type;
    values.typeOptions = options();
    onsave(values);
  }
</script>

<div
  data-component="BasePropertyEditor"
  class="absolute left-0 top-8 z-40 w-72 rounded-md border border-border bg-surface-raised p-3 text-left shadow-lg"
  role="dialog"
  aria-label={t('Edit property')}
>
  <div class="mb-2 flex items-center">
    <p class="text-sm font-medium">{t('Edit property')}</p>
    <button
      class="ml-auto flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
      type="button"
      title={t('Close')}
      aria-label={t('Close')}
      onclick={onclose}
    >
      <IconX size={16} stroke={1.7} />
    </button>
  </div>

  <label class="mb-2 block">
    <span class="mb-1 block text-xs text-text-muted">{t('Name')}</span>
    <TextInput bind:value={name} />
  </label>

  {#if !property.isPrimary}
    <!--
      Вид первичного свойства не меняется: оно держит название строки, и любой
      другой вид оставил бы базу без названий.
    -->
    <label class="mb-2 block">
      <span class="mb-1 block text-xs text-text-muted">{t('Type')}</span>
      <Select bind:value={type} label={t('Type')} options={typeOptions} />
    </label>
  {/if}

  <!--
    Настройки вида. Без них число показывается как есть — вычисленное среднее
    выглядит как `6.66333333333333`, — а у даты пропадает время.
  -->
  {#if type === 'number'}
    <label class="mb-2 block">
      <span class="mb-1 block text-xs text-text-muted">{t('Format')}</span>
      <Select
        bind:value={numberFormat}
        label={t('Format')}
        options={NUMBER_FORMATS.map((one) => ({ value: one.value, label: t(one.label) }))}
      />
    </label>
    {#if numberFormat === 'currency'}
      <label class="mb-2 block">
        <span class="mb-1 block text-xs text-text-muted">{t('Currency')}</span>
        <TextInput bind:value={currency} placeholder="USD" />
      </label>
    {/if}
    <label class="mb-2 block">
      <span class="mb-1 block text-xs text-text-muted">{t('Decimal places')}</span>
      <TextInput bind:value={precision} placeholder="2" />
    </label>
    <label class="mb-2 block">
      <span class="mb-1 block text-xs text-text-muted">
        {t('Thousands and decimal separators')}
      </span>
      <Select
        bind:value={separator}
        label={t('Thousands and decimal separators')}
        options={SEPARATORS.map((one) => ({ value: one.value, label: t(one.label) }))}
      />
    </label>
  {/if}

  {#if type === 'date'}
    <label class="mb-2 flex items-center gap-2">
      <input type="checkbox" bind:checked={includeTime} />
      <span class="text-xs text-text-muted">{t('Include time')}</span>
    </label>
    {#if includeTime}
      <label class="mb-2 block">
        <span class="mb-1 block text-xs text-text-muted">{t('Time format')}</span>
        <Select
          bind:value={timeFormat}
          label={t('Time format')}
          options={TIME_FORMATS.map((one) => ({ value: one.value, label: t(one.label) }))}
        />
      </label>
    {/if}
  {/if}

  {#if type === 'checkbox'}
    <label class="mb-2 flex items-center gap-2">
      <input type="checkbox" bind:checked={defaultChecked} />
      <span class="text-xs text-text-muted">{t('Checked by default')}</span>
    </label>
  {/if}

  {#if type === 'person'}
    <label class="mb-2 flex items-center gap-2">
      <input type="checkbox" bind:checked={allowMultiple} />
      <span class="text-xs text-text-muted">{t('Allow multiple people')}</span>
    </label>
  {/if}

  {#if type === 'formula'}
    <!--
      Выражение считает сервер. Ошибку разбора он отдаёт отказом, и она
      показывается общим сообщением окна — молчаливое сохранение негодной
      формулы означало бы столбец ошибок во всех строках.
    -->
    <label class="mb-2 block">
      <span class="mb-1 block text-xs text-text-muted">{t('Formula')}</span>
      <TextInput
        bind:value={formulaSource}
        placeholder="prop(&quot;Цена&quot;) * prop(&quot;Кол-во&quot;)"
      />
    </label>
  {/if}

  {#if withChoices}
    <label class="mb-2 flex items-center gap-2">
      <input type="checkbox" bind:checked={alphabetize} />
      <span class="text-xs text-text-muted">{t('Alphabetize')}</span>
    </label>
    <p class="mb-1 text-xs text-text-muted">{t('Options')}</p>
    <div class="mb-2 space-y-1">
      {#each choices as choice, at (choice.id)}
        <div class="flex items-center gap-1">
          <input
            class="h-8 flex-1 rounded border border-border-input bg-surface px-2 text-sm outline-none focus:border-accent"
            value={choice.name}
            aria-label={t('Option name')}
            onchange={(event) => {
              const next = (event.currentTarget as HTMLInputElement).value;
              choices = choices.map((one, index) => (index === at ? { ...one, name: next } : one));
            }}
          />
          <button
            class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
            type="button"
            aria-label={t('Delete')}
            onclick={() => (choices = choices.filter((_, index) => index !== at))}
          >
            <IconX size={15} stroke={1.7} />
          </button>
        </div>
      {/each}
      <button
        class="flex items-center gap-1 text-sm text-text-muted hover:text-text"
        type="button"
        onclick={addChoice}
      >
        <IconPlus size={15} stroke={1.7} />
        {t('Add option')}
      </button>
    </div>
  {/if}

  <div class="flex flex-wrap gap-2">
    <Button disabled={busy} onclick={save}>{busy ? t('Loading...') : t('Save')}</Button>
    {#if !property.isPrimary}
      <Button variant="quiet" disabled={busy} onclick={ondelete}>{t('Delete')}</Button>
    {/if}
  </div>
</div>
