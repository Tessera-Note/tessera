<script lang="ts">
  import { IconChevronDown, IconChevronUp, IconX } from '@tabler/icons-svelte';
  import Confirm from '$lib/components/ui/Confirm.svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import BaseCell from './BaseCell.svelte';
  import { cellText, type CellContext } from '../cells';
  import type { BaseProperty, BaseRow } from '../services/bases';

  type Props = {
    row: BaseRow;
    /** Все свойства, включая скрытые в таблице: карточка показывает строку целиком. */
    properties: BaseProperty[];
    context: CellContext;
    people: { id: string; name: string | null }[];
    editable: boolean;
    /** Страница базы. Нужна ячейке с файлом. */
    pageId: string;
    /** Отказ загрузки файла в ячейку. Показывает его экран. */
    onfail?: ((error: unknown) => void) | null;
    busy: string | null;
    /**
     * Переход к соседней записи.
     *
     * Карточку открывают, чтобы просмотреть строки подряд. Без перехода
     * приходится закрывать её и искать следующую в таблице глазами.
     * Отсутствие обработчика означает край перечня — кнопка гаснет.
     */
    onprevious?: (() => void) | null;
    onnext?: (() => void) | null;
    onwrite: (property: BaseProperty, value: unknown) => void;
    ondelete: () => void;
    onclose: () => void;
  };
  const {
    row,
    properties,
    context,
    people,
    editable,
    pageId,
    onfail = null,
    busy,
    onprevious = null,
    onnext = null,
    onwrite,
    ondelete,
    onclose
  }: Props = $props();

  const t = $derived(locale.t);

  const title = $derived.by(() => {
    const primary = properties.find((one) => one.isPrimary) ?? properties[0];
    if (!primary) return t('Untitled');
    return (
      cellText(row.cells[primary.id], primary.type, primary.typeOptions, context) || t('Untitled')
    );
  });
</script>

<!--
  Карточка строки. Показывает **все** свойства, включая скрытые в таблице:
  колонку прячут ради ширины, а не ради тайны, и в карточке она нужна.
-->
<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      onclose();
      return;
    }
    // Стрелки листают записи, как в v1. Только без набора текста: иначе
    // перемещение каретки внутри поля уводило бы на соседнюю строку.
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
      (event.target as HTMLElement | null)?.tagName ?? ''
    );
    if (inField) return;
    if (event.key === 'ArrowUp') onprevious?.();
    if (event.key === 'ArrowDown') onnext?.();
  }}
/>

<div
  data-component="BaseRowCard"
  class="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-border bg-surface-raised p-4 shadow-lg"
  role="dialog"
  aria-label={title}
>
  <div class="mb-4 flex items-start gap-2">
    <h2 class="flex-1 text-lg font-medium">{title}</h2>
    <button
      class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover disabled:opacity-40"
      type="button"
      title={t('Previous record')}
      aria-label={t('Previous record')}
      disabled={!onprevious}
      onclick={() => onprevious?.()}
    >
      <IconChevronUp size={17} stroke={1.7} />
    </button>
    <button
      class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover disabled:opacity-40"
      type="button"
      title={t('Next record')}
      aria-label={t('Next record')}
      disabled={!onnext}
      onclick={() => onnext?.()}
    >
      <IconChevronDown size={17} stroke={1.7} />
    </button>
    <button
      class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
      type="button"
      title={t('Close')}
      aria-label={t('Close')}
      onclick={onclose}
    >
      <IconX size={17} stroke={1.7} />
    </button>
  </div>

  <dl class="space-y-3">
    {#each properties as property (property.id)}
      <div>
        <dt class="mb-1 text-xs text-text-muted">{property.name}</dt>
        <dd>
          <BaseCell
            {property}
            value={row.cells[property.id]}
            {context}
            {people}
            {editable}
            {pageId}
            {onfail}
            onwrite={(value) => onwrite(property, value)}
          />
        </dd>
      </div>
    {/each}
  </dl>

  <div class="mt-4 space-y-1 border-t border-border pt-3 text-xs text-text-muted">
    {#if row.createdAt}
      <p>{t('Created')}: {new Date(row.createdAt).toLocaleString(locale.current)}</p>
    {/if}
    {#if row.updatedAt}
      <p>{t('Updated')}: {new Date(row.updatedAt).toLocaleString(locale.current)}</p>
    {/if}
  </div>

  {#if editable}
    <div class="mt-4">
      <!-- Вопрос обязателен: строка уходит без возврата, а карточка
           закрывается тем же нажатием, и промах остался бы незамеченным. -->
      <Confirm
        label={t('Delete')}
        question={t('Delete record?')}
        disabled={busy === row.id}
        onconfirm={ondelete}
      />
    </div>
  {/if}
</div>
