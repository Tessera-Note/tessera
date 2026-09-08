<script lang="ts">
  import { IconCheck, IconExternalLink, IconLinkOff } from '@tabler/icons-svelte';
  import { untrack } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    editor: Editor;
    /** Где открыть: прямоугольник выделения в окне браузера. */
    at: { left: number; bottom: number };
    /** Ссылка уже стоит: тогда её можно снять и открыть. */
    existing: string | null;
    onclose: () => void;
  };
  const { editor, at, existing, onclose }: Props = $props();

  const t = $derived(locale.t);

  // Поле заводится тем, что стоит сейчас, и дальше живёт само: панель
  // открывается заново на каждую ссылку, следить за доводом незачем.
  let address = $state(untrack(() => existing) ?? '');
  let field: HTMLInputElement | undefined = $state();

  $effect(() => {
    field?.focus();
    field?.select();
  });

  /**
   * Достроить схему.
   *
   * Человек пишет «example.com», и без схемы браузер считает это относительным
   * путём внутри вики. Схему, набранную самим человеком, не трогаем: там может
   * быть `mailto:` и внутренний адрес.
   */
  function normalize(value: string): string {
    const clean = value.trim();
    if (!clean) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/')) return clean;
    return `https://${clean}`;
  }

  function apply() {
    const href = normalize(address);
    if (!href) {
      drop();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    onclose();
  }

  function drop() {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onclose();
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      apply();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }
</script>

<div
  data-component="LinkPanel"
  class="fixed z-50 flex items-center gap-1 rounded-md border border-border bg-surface-raised p-1 shadow-lg"
  style:left="{at.left}px"
  style:top="{at.bottom + 8}px"
>
  <input
    bind:this={field}
    bind:value={address}
    class="h-8 w-64 rounded bg-surface px-2 text-sm text-text outline-none placeholder:text-text-muted"
    type="url"
    placeholder={t('Enter link')}
    aria-label={t('Enter link')}
    onkeydown={keydown}
  />
  <button
    class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
    type="button"
    title={t('Save')}
    aria-label={t('Save')}
    onclick={apply}
  >
    <IconCheck size={17} stroke={1.7} />
  </button>
  {#if existing}
    <a
      class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
      href={existing}
      target="_blank"
      rel="noreferrer noopener"
      title={t('Open link')}
      aria-label={t('Open link')}
    >
      <IconExternalLink size={17} stroke={1.7} />
    </a>
    <button
      class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
      type="button"
      title={t('Remove link')}
      aria-label={t('Remove link')}
      onclick={drop}
    >
      <IconLinkOff size={17} stroke={1.7} />
    </button>
  {/if}
</div>
