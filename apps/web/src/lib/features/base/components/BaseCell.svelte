<script lang="ts">
  import { asList, cellText, choicesOf, type CellContext } from '../cells';
  import { COMPUTED_TYPES, type PropertyType } from '../types';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { BaseProperty } from '../services/bases';

  type Props = {
    property: BaseProperty;
    value: unknown;
    context: CellContext;
    editable: boolean;
    /** Кого можно выбрать в ячейке с человеком. */
    people: { id: string; name: string | null }[];
    onwrite: (value: unknown) => void;
  };
  const { property, value, context, editable, people, onwrite }: Props = $props();

  const t = $derived(locale.t);
  const type = $derived(property.type as PropertyType);
  /** Вычисляемое значение ставит сервер: поле ввода обещало бы правку, которой нет. */
  const computed = $derived(COMPUTED_TYPES.includes(type));
  const choices = $derived(choicesOf(property.typeOptions));
  const shown = $derived(cellText(value, type, property.typeOptions, context));

  /** Пустая строка означает «очистить»: сервер понимает `null`. */
  function write(raw: string) {
    onwrite(raw.trim() === '' ? null : raw);
  }

  function writeNumber(raw: string) {
    if (raw.trim() === '') {
      onwrite(null);
      return;
    }
    const made = Number(raw);
    onwrite(Number.isFinite(made) ? made : null);
  }

  /** Переключить одно значение во множественном выборе. */
  function toggleMany(id: string) {
    const current = asList(value);
    const next = current.includes(id) ? current.filter((one) => one !== id) : [...current, id];
    onwrite(next.length === 0 ? null : next);
  }

  const field =
    'w-full rounded border border-transparent bg-transparent px-2 py-1 hover:border-border focus:border-border disabled:opacity-70';
</script>

{#if !editable || computed}
  <!--
    Только показ. Вычисляемые свойства сюда попадают всегда: их значение
    ставит сервер при записи строки, и правка отвергается.
  -->
  <span class="block px-2 py-1 text-text-muted">{shown || '—'}</span>
{:else if type === 'checkbox'}
  <input
    type="checkbox"
    checked={value === true}
    aria-label={property.name}
    onchange={(event) => onwrite((event.currentTarget as HTMLInputElement).checked)}
  />
{:else if type === 'select' || type === 'status'}
  <select
    class={field}
    value={typeof value === 'string' ? value : ''}
    aria-label={property.name}
    onchange={(event) => {
      const picked = (event.currentTarget as HTMLSelectElement).value;
      onwrite(picked === '' ? null : picked);
    }}
  >
    <option value="">—</option>
    {#each choices as choice (choice.id)}
      <option value={choice.id}>{choice.name}</option>
    {/each}
  </select>
{:else if type === 'multiSelect'}
  <div class="flex flex-wrap gap-1 px-1 py-1">
    {#each choices as choice (choice.id)}
      {@const picked = asList(value).includes(choice.id)}
      <button
        class="rounded border px-2 py-0.5 text-xs"
        class:border-accent={picked}
        class:text-accent={picked}
        class:border-border={!picked}
        class:text-text-muted={!picked}
        type="button"
        aria-pressed={picked}
        onclick={() => toggleMany(choice.id)}
      >
        {choice.name}
      </button>
    {:else}
      <span class="px-1 text-text-muted">{t('No options yet')}</span>
    {/each}
  </div>
{:else if type === 'person'}
  <select
    class={field}
    value={typeof value === 'string' ? value : ''}
    aria-label={property.name}
    onchange={(event) => {
      const picked = (event.currentTarget as HTMLSelectElement).value;
      onwrite(picked === '' ? null : picked);
    }}
  >
    <option value="">—</option>
    {#each people as one (one.id)}
      <option value={one.id}>{one.name ?? one.id}</option>
    {/each}
  </select>
{:else if type === 'date'}
  <input
    class={field}
    type="date"
    value={typeof value === 'string' ? value.slice(0, 10) : ''}
    aria-label={property.name}
    onchange={(event) => write((event.currentTarget as HTMLInputElement).value)}
  />
{:else if type === 'number'}
  <input
    class={field}
    type="number"
    value={value === null || value === undefined ? '' : String(value)}
    aria-label={property.name}
    onchange={(event) => writeNumber((event.currentTarget as HTMLInputElement).value)}
  />
{:else if type === 'longText'}
  <textarea
    class="{field} min-h-16"
    value={typeof value === 'string' ? value : ''}
    aria-label={property.name}
    onchange={(event) => write((event.currentTarget as HTMLTextAreaElement).value)}
  ></textarea>
{:else if type === 'page'}
  <!--
    Ссылка на страницу правится идентификатором: выбора страницы у этого экрана
    нет, а показывается уже развёрнутое название.
  -->
  <input
    class={field}
    value={typeof value === 'string' ? value : ''}
    placeholder={shown}
    aria-label={property.name}
    onchange={(event) => write((event.currentTarget as HTMLInputElement).value)}
  />
{:else}
  <input
    class={field}
    type={type === 'url' ? 'url' : type === 'email' ? 'email' : 'text'}
    value={typeof value === 'string' ? value : shown}
    aria-label={property.name}
    onchange={(event) => write((event.currentTarget as HTMLInputElement).value)}
  />
{/if}
