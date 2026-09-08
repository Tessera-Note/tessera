<script lang="ts">
  import { IconCheck } from '@tabler/icons-svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps;
  const { node, attributes, selected, editable, editor, updateAttributes, position }: Props =
    $props();

  const t = $derived(locale.t);

  /** Цвета состояния. Значения из v1: они же лежат в документе. */
  const TONES: Record<string, string> = {
    gray: 'bg-surface-active text-text-muted',
    blue: 'bg-sky-100 text-sky-800',
    green: 'bg-emerald-100 text-emerald-800',
    yellow: 'bg-amber-100 text-amber-900',
    red: 'bg-rose-100 text-rose-800',
    purple: 'bg-accent-soft text-accent'
  };

  /** Палитра: цвет, его образец и подпись из словаря. */
  const COLORS: { id: string; swatch: string; label: string }[] = [
    { id: 'gray', swatch: 'bg-slate-400', label: 'Gray' },
    { id: 'blue', swatch: 'bg-sky-400', label: 'Blue' },
    { id: 'green', swatch: 'bg-emerald-400', label: 'Green' },
    { id: 'yellow', swatch: 'bg-amber-400', label: 'Yellow' },
    { id: 'red', swatch: 'bg-rose-400', label: 'Red' },
    { id: 'purple', swatch: 'bg-violet-400', label: 'Purple' }
  ];

  const color = $derived(String(attributes.color ?? 'gray'));
  const tone = $derived(TONES[color] ?? TONES.gray);
  const text = $derived(String(attributes.text ?? ''));

  let open = $state(false);
  let field: HTMLInputElement | undefined = $state();

  /**
   * Только что вставленный статус открывается сам.
   *
   * Иначе на странице остаётся пустая метка без единой подсказки, что в неё
   * надо что-то вписать: вставка из перечня блоков не даёт места набору, как
   * его даёт обычный узел с содержимым. Отметку ставит само расширение, и
   * снимается она здесь же — иначе откроется и следующий по счёту статус.
   */
  $effect(() => {
    const storage = editor.storage.status as { autoOpen?: boolean } | undefined;
    if (!storage?.autoOpen || !editable) return;
    storage.autoOpen = false;
    open = true;
  });

  $effect(() => {
    if (open) field?.focus();
  });

  // Уход в чтение закрывает правку. Окно живёт в разметке отдельно от метки, и
  // оставленное открытым оно висело бы над страницей без единой кнопки, чтобы
  // его убрать.
  $effect(() => {
    if (!editable) open = false;
  });

  /** Убрать узел целиком. Нужен закрытию пустого статуса. */
  function drop() {
    const at = position();
    if (at === undefined) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: at, to: at + node.nodeSize })
      .run();
  }

  /**
   * Закрыть окно правки.
   *
   * Пустой статус при закрытии удаляется: метка без текста не видна на
   * странице, и оставленная она превращается в невидимое препятствие для
   * каретки, которое нечем ни увидеть, ни убрать.
   */
  function close() {
    open = false;
    if (!text) drop();
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      open = false;
      const at = position();
      if (at !== undefined) editor.commands.focus(at + node.nodeSize);
    }
  }
</script>

<span class="relative inline-block">
  <!--
    В правке метка это кнопка, в чтении — простой текст. Один элемент с
    выключаемой ролью пришлось бы снабжать своей обработкой клавиш, а кнопка
    несёт её сама.
  -->
  {#if editable}
    <button
      data-component="StatusView"
      class="rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide {tone}"
      class:outline={selected}
      class:outline-1={selected}
      class:outline-accent={selected}
      type="button"
      aria-label={text || t('Set status')}
      aria-haspopup="dialog"
      aria-expanded={open}
      onclick={() => (open = true)}
    >
      {text || t('Set status')}
    </button>
  {:else if text}
    <!--
      В чтении пустая метка не показывается вовсе. Заполнять её читателю нечем,
      и призыв «задать статус» звал бы к действию, которого у него нет. Своих
      пустых меток не остаётся — закрытие их удаляет, — но привезённая из v1
      страница такую метку принести может.
    -->
    <span
      data-component="StatusView"
      class="rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide {tone}"
      class:outline={selected}
      class:outline-1={selected}
      class:outline-accent={selected}
    >
      {text}
    </span>
  {/if}

  {#if open}
    <span
      class="absolute left-0 top-full z-50 mt-1 block w-56 rounded-md border border-border bg-surface-raised p-2 shadow-lg"
      role="dialog"
      aria-label={t('Status')}
    >
      <input
        bind:this={field}
        class="mb-2 h-8 w-full rounded border border-border-input bg-surface px-2 text-sm text-text outline-none focus:border-accent"
        type="text"
        value={text}
        placeholder={t('Status text')}
        aria-label={t('Status text')}
        oninput={(event) => updateAttributes({ text: event.currentTarget.value.toUpperCase() })}
        onkeydown={keydown}
      />
      <span class="flex justify-center gap-1.5">
        {#each COLORS as one (one.id)}
          <button
            class="flex h-5 w-5 items-center justify-center rounded-full text-white {one.swatch}"
            class:ring-2={color === one.id}
            class:ring-accent={color === one.id}
            type="button"
            title={t(one.label)}
            aria-label={t(one.label)}
            aria-pressed={color === one.id}
            onclick={() => updateAttributes({ color: one.id })}
          >
            {#if color === one.id}<IconCheck size={13} stroke={2.4} />{/if}
          </button>
        {/each}
      </span>
    </span>
  {/if}
</span>

<svelte:window
  onpointerdown={(event) => {
    if (!open) return;
    // Целью бывает не только элемент: событие приходит и на сам документ, у
    // которого нет `closest`.
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('[role="dialog"], [data-component="StatusView"]')
    )
      return;
    close();
  }}
/>
