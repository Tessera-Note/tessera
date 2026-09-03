<script lang="ts">
  import {
    IconAlertTriangleFilled,
    IconCircleCheckFilled,
    IconCircleXFilled,
    IconInfoCircleFilled,
    IconNotes
  } from '@tabler/icons-svelte';
  import type { ComponentType } from 'svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { CalloutType } from '@tessera/editor-ext';
  import EmojiPicker from '../EmojiPicker.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps;
  const { attributes, editable, editor, position }: Props = $props();

  const t = $derived(locale.t);

  /**
   * Виды выноски. Значения из v1: они же лежат в документе, и переименование
   * здесь означало бы, что старая страница открывается видом по умолчанию.
   */
  const KINDS: {
    id: CalloutType;
    label: string;
    icon: ComponentType;
    frame: string;
    mark: string;
  }[] = [
    {
      id: 'info',
      label: 'Info',
      icon: IconInfoCircleFilled,
      frame: 'border-sky-200 bg-sky-50',
      mark: 'text-sky-600'
    },
    {
      id: 'note',
      label: 'Note',
      icon: IconNotes,
      frame: 'border-violet-200 bg-violet-50',
      mark: 'text-violet-600'
    },
    {
      id: 'success',
      label: 'Success',
      icon: IconCircleCheckFilled,
      frame: 'border-emerald-200 bg-emerald-50',
      mark: 'text-emerald-600'
    },
    {
      id: 'warning',
      label: 'Warning',
      icon: IconAlertTriangleFilled,
      frame: 'border-amber-200 bg-amber-50',
      mark: 'text-amber-600'
    },
    {
      id: 'danger',
      label: 'Danger',
      icon: IconCircleXFilled,
      frame: 'border-rose-200 bg-rose-50',
      mark: 'text-rose-600'
    }
  ];

  /**
   * Вид `default` из общего пакета сюда не попадает нарочно: своих цвета и
   * значка у него нет, и показывать его нечем, кроме как видом «сведения».
   */
  const kind = $derived(KINDS.find((one) => one.id === attributes.type) ?? KINDS[0]);
  const custom = $derived(String(attributes.icon ?? '').trim());

  let choosing = $state(false);
  let picking = $state(false);

  // Уход в чтение закрывает выбор: править нечего, а окно осталось бы висеть.
  $effect(() => {
    if (!editable) {
      choosing = false;
      picking = false;
    }
  });

  /**
   * Правка идёт командами расширения, а не записью атрибутов напрямую: команда
   * сверяет вид со списком допустимых, и мимо неё в документ попал бы вид,
   * которого не знает ни разбор разметки, ни вывоз в Markdown.
   */
  function at(): number | undefined {
    return position();
  }

  function setKind(id: CalloutType) {
    const start = at();
    if (start === undefined) return;
    editor
      .chain()
      .setTextSelection(start + 1)
      .updateCalloutType(id)
      .run();
    choosing = false;
  }

  function setIcon(icon: string) {
    const start = at();
    if (start === undefined) return;
    editor
      .chain()
      .setTextSelection(start + 1)
      .updateCalloutIcon(icon)
      .run();
    picking = false;
    choosing = false;
  }
</script>

<div class="relative rounded-lg border px-3 py-2.5 {kind.frame}">
  <div class="flex gap-2.5">
    {#if editable}
      <button
        class="mt-0.5 shrink-0 self-start rounded {kind.mark}"
        type="button"
        title={t(kind.label)}
        aria-label={t(kind.label)}
        aria-haspopup="dialog"
        aria-expanded={choosing}
        onclick={() => (choosing = !choosing)}
      >
        {#if custom}
          <span class="text-lg leading-none">{custom}</span>
        {:else}
          <kind.icon size={19} />
        {/if}
      </button>
    {:else}
      <span class="mt-0.5 shrink-0 self-start {kind.mark}" aria-label={t(kind.label)}>
        {#if custom}
          <span class="text-lg leading-none">{custom}</span>
        {:else}
          <kind.icon size={19} />
        {/if}
      </span>
    {/if}

    <!-- Содержимое ставит сюда сам редактор: это узлы документа. -->
    <div class="min-w-0 flex-1" data-node-view-content></div>
  </div>

  {#if choosing}
    <div
      class="absolute left-2 top-full z-50 mt-1 flex items-center gap-1 rounded-md border border-border bg-surface-raised p-1 shadow-lg"
      role="dialog"
      aria-label={t('Callout')}
    >
      {#each KINDS as one (one.id)}
        <button
          class="flex h-7 w-7 items-center justify-center rounded hover:bg-surface-hover {one.mark}"
          class:bg-surface-active={!custom && one.id === kind.id}
          type="button"
          title={t(one.label)}
          aria-label={t(one.label)}
          aria-pressed={!custom && one.id === kind.id}
          onclick={() => setKind(one.id)}
        >
          <one.icon size={17} />
        </button>
      {/each}
      <span class="mx-0.5 h-5 w-px bg-border"></span>
      <button
        class="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover"
        type="button"
        title={t('Choose icon')}
        aria-label={t('Choose icon')}
        onclick={() => (picking = true)}
      >
        <span class="text-base leading-none">{custom || '☺'}</span>
      </button>
    </div>
  {/if}

  {#if picking}
    <div class="absolute left-2 top-full z-50 mt-1">
      <EmojiPicker
        current={custom || null}
        onpick={setIcon}
        onclear={() => setIcon('')}
        onclose={() => (picking = false)}
      />
    </div>
  {/if}
</div>

<svelte:window
  onpointerdown={(event) => {
    if (!choosing && !picking) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-node-view="callout"]')) return;
    choosing = false;
    picking = false;
  }}
/>
