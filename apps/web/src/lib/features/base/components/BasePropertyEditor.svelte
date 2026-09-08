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

  function save() {
    const values: { name?: string; type?: string; typeOptions?: Record<string, unknown> } = {};
    if (name.trim() && name !== property.name) values.name = name.trim();
    if (type !== property.type) values.type = type;
    if (withChoices) {
      const kept = choices.filter((one) => one.name.trim());
      values.typeOptions = {
        ...(property.typeOptions ?? {}),
        choices: kept,
        choiceOrder: kept.map((one) => one.id)
      };
    }
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

  {#if withChoices}
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
