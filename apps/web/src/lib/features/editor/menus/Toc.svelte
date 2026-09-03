<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import { locale } from '$lib/stores/i18n.svelte';

  type Props = {
    editor: Editor;
    /** Счётчик правок: заголовки читаются из документа заново после каждой. */
    tick: number;
  };
  const { editor, tick }: Props = $props();

  const t = $derived(locale.t);

  type Entry = { id: string; level: number; text: string; pos: number };

  /**
   * Заголовки документа.
   *
   * Собираются обходом узлов, а не запросом к серверу: страница правится прямо
   * сейчас, и оглавление с сервера отставало бы от неё на всю сессию правки.
   */
  const entries = $derived.by<Entry[]>(() => {
    void tick;
    const found: Entry[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'heading') return true;
      const text = node.textContent.trim();
      if (!text) return false;
      found.push({
        id: String(node.attrs.id ?? pos),
        level: Number(node.attrs.level ?? 1),
        text,
        pos
      });
      return false;
    });
    return found;
  });

  /** Перевести взгляд на заголовок: каретка на него, вид — к нему. */
  function jump(entry: Entry) {
    editor
      .chain()
      .focus()
      .setTextSelection(entry.pos + 1)
      .run();
    editor.view.dom
      .querySelector(`[data-id="${entry.id}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
</script>

<nav data-component="Toc" class="mb-3 rounded-md border border-border bg-surface-raised p-3">
  <p class="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
    {t('Table of contents')}
  </p>
  {#if entries.length === 0}
    <p class="text-sm text-text-muted">{t('Add headings to create a table of contents.')}</p>
  {:else}
    <ul class="space-y-1 text-sm">
      {#each entries as entry (entry.id)}
        <li style:padding-left="{(Math.min(entry.level, 4) - 1) * 12}px">
          <button
            class="text-left text-text-muted hover:text-text"
            type="button"
            onclick={() => jump(entry)}
          >
            {entry.text}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>
