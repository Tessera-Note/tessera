<script lang="ts">
  import { IconChevronDown, IconChevronUp, IconLetterCase, IconX } from '@tabler/icons-svelte';
  import type { Editor } from '@tiptap/core';
  import { untrack } from 'svelte';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    editor: Editor;
    /** Счётчик правок: число найденного держит расширение, а не разметка. */
    tick: number;
    onclose: () => void;
  };
  const { editor, tick, onclose }: Props = $props();

  const t = $derived(locale.t);

  let needle = $state('');
  let replacement = $state('');
  let caseSensitive = $state(false);
  let field: HTMLInputElement | undefined = $state();

  $effect(() => {
    field?.focus();
  });

  /**
   * Поиск переносится в редактор при каждой правке строки.
   *
   * Не по нажатию: подсветка совпадений идёт по мере набора, и отдельная кнопка
   * «искать» означала бы, что до неё подсветка показывает прошлый запрос.
   */
  $effect(() => {
    const term = needle;
    const sensitive = caseSensitive;
    // Строка и регистр читаются до `untrack`, сама передача идёт внутри него:
    // команда редактора шлёт транзакцию, а на транзакции хозяин панели правит
    // своё состояние. Без разделения эффект подписывался бы на это состояние.
    untrack(() => {
      editor.commands.setCaseSensitive(sensitive);
      editor.commands.setSearchTerm(term);
      editor.commands.resetIndex();
    });
  });

  $effect(() => {
    const text = replacement;
    untrack(() => editor.commands.setReplaceTerm(text));
  });

  const found = $derived.by(() => {
    void tick;
    const storage = editor.storage.searchAndReplace;
    return { total: storage?.results?.length ?? 0, at: storage?.resultIndex ?? 0 };
  });

  /**
   * Закрыть и убрать подсветку.
   *
   * Пустой запрос снимает украшения: оставленные, они держались бы на странице
   * и после закрытия окна поиска.
   */
  function close() {
    editor.commands.setSearchTerm('');
    onclose();
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      editor.commands[event.shiftKey ? 'previousSearchResult' : 'nextSearchResult']();
      editor.commands.selectCurrentItem();
    }
  }
</script>

<div
  data-component="FindReplace"
  class="mb-3 flex flex-wrap items-center gap-1 rounded-md border border-border bg-surface-raised p-1"
  role="search"
>
  <input
    bind:this={field}
    bind:value={needle}
    class="h-8 w-48 rounded bg-surface px-2 text-sm text-text outline-none placeholder:text-text-muted"
    type="search"
    placeholder={t('Find')}
    aria-label={t('Find')}
    onkeydown={keydown}
  />
  <span class="w-16 text-center text-xs text-text-muted" aria-live="polite">
    {found.total ? `${found.at + 1}/${found.total}` : t('No results')}
  </span>

  <button
    class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
    class:bg-surface-active={caseSensitive}
    type="button"
    title={t('Match case')}
    aria-label={t('Match case')}
    aria-pressed={caseSensitive}
    onclick={() => (caseSensitive = !caseSensitive)}
  >
    <IconLetterCase size={17} stroke={1.7} />
  </button>
  <button
    class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
    type="button"
    title={t('Previous')}
    aria-label={t('Previous')}
    onclick={() => {
      editor.commands.previousSearchResult();
      editor.commands.selectCurrentItem();
    }}
  >
    <IconChevronUp size={17} stroke={1.7} />
  </button>
  <button
    class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
    type="button"
    title={t('Next')}
    aria-label={t('Next')}
    onclick={() => {
      editor.commands.nextSearchResult();
      editor.commands.selectCurrentItem();
    }}
  >
    <IconChevronDown size={17} stroke={1.7} />
  </button>

  <span class="mx-1 h-5 w-px bg-border"></span>

  <input
    bind:value={replacement}
    class="h-8 w-48 rounded bg-surface px-2 text-sm text-text outline-none placeholder:text-text-muted"
    type="text"
    placeholder={t('Replace')}
    aria-label={t('Replace')}
    onkeydown={keydown}
  />
  <button
    class="h-8 rounded px-2 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
    type="button"
    disabled={!found.total}
    onclick={() => editor.commands.replace()}
  >
    {t('Replace')}
  </button>
  <button
    class="h-8 rounded px-2 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
    type="button"
    disabled={!found.total}
    onclick={() => editor.commands.replaceAll()}
  >
    {t('Replace all')}
  </button>

  <button
    class="ml-auto flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
    type="button"
    title={t('Close')}
    aria-label={t('Close')}
    onclick={close}
  >
    <IconX size={17} stroke={1.7} />
  </button>
</div>
