<script lang="ts">
  import { IconCheck, IconCopy } from '@tabler/icons-svelte';
  import { untrack } from 'svelte';
  import { locale } from '$lib/stores/i18n.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import type { NodeViewProps } from '../node-view.svelte';

  type Props = NodeViewProps & {
    /** Перечень языков подсветки. Приходит от расширения, своего списка нет. */
    languages: () => string[];
  };
  const { node, attributes, editable, editor, updateAttributes, position, languages }: Props =
    $props();

  const t = $derived(locale.t);

  const language = $derived(String(attributes.language ?? ''));
  const source = $derived(node.textContent);

  const known = $derived([...languages()].sort());

  /**
   * Диаграмма рисуется из того же блока кода, что и обычный текст.
   *
   * Так же, как в v1: у диаграммы нет своего узла схемы — это блок кода с
   * языком `mermaid`. Отдельный узел означал бы, что страница из v1 приезжает
   * с узлом, которого схема не знает.
   */
  const isMermaid = $derived(language === 'mermaid');

  let drawn = $state('');
  let broken = $state<string | null>(null);

  /**
   * Пока каретка внутри блока, показывается исходный текст, а не диаграмма:
   * иначе набирать её вслепую.
   */
  let inside = $state(false);
  $effect(() => {
    const watch = () => {
      const at = position();
      if (at === undefined) {
        inside = false;
        return;
      }
      const { from, to } = editor.state.selection;
      inside = (from >= at && from < at + node.nodeSize) || (to > at && to <= at + node.nodeSize);
    };
    watch();
    editor.on('selectionUpdate', watch);
    return () => editor.off('selectionUpdate', watch);
  });

  $effect(() => {
    const text = source;
    const dark = theme.current === 'dark';
    if (!isMermaid || !text.trim()) {
      untrack(() => {
        drawn = '';
        broken = null;
      });
      return;
    }

    let dropped = false;
    void (async () => {
      // Библиотека грузится по требованию: она весит больше мегабайта, а
      // диаграмма есть далеко не на каждой странице.
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: dark ? 'dark' : 'default'
      });
      try {
        const { svg } = await mermaid.render(`mermaid-${crypto.randomUUID()}`, text);
        if (dropped) return;
        drawn = svg;
        broken = null;
      } catch (failure) {
        if (dropped) return;
        drawn = '';
        // Причина показывается только тому, кто правит: читателю чинить нечего,
        // а текст ошибки библиотеки ему ничего не говорит.
        broken = editable
          ? `${t('Mermaid diagram error:')} ${failure instanceof Error ? failure.message : String(failure)}`
          : t('Invalid Mermaid diagram');
      }
    })();

    return () => {
      dropped = true;
    };
  });

  /** Показывать ли исходный текст. У диаграммы — только пока её правят. */
  const showSource = $derived(!isMermaid || !drawn || inside || !source.trim());

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      copied = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 2000);
    } catch {
      // Буфер недоступен: браузер не дал права. Показывать нечего.
    }
  }

  $effect(() => () => {
    if (timer) clearTimeout(timer);
  });
</script>

<div data-component="CodeBlockView" class="tessera-code">
  <div class="tessera-code-menu" contenteditable="false">
    <select
      class="h-7 rounded border border-border-input bg-surface px-1.5 text-xs text-text outline-none focus:border-accent"
      value={language}
      disabled={!editable}
      aria-label={t('Language')}
      onchange={(event) => updateAttributes({ language: event.currentTarget.value })}
    >
      <option value="">{t('Language')}</option>
      {#each known as one (one)}
        <option value={one}>{one}</option>
      {/each}
    </select>

    <button
      class="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
      type="button"
      title={copied ? t('Copied') : t('Copy')}
      aria-label={copied ? t('Copied') : t('Copy')}
      onclick={copy}
    >
      {#if copied}
        <IconCheck size={15} stroke={2} />
      {:else}
        <IconCopy size={15} stroke={1.7} />
      {/if}
    </button>
  </div>

  <pre spellcheck="false" hidden={!showSource}><code
      class="language-{language}"
      data-node-view-content></code></pre>

  {#if isMermaid && !showSource}
    <!--
      Разметку рисует сама библиотека: это её вывод, а не текст человека.
      Уровень строгости у неё по умолчанию, тот же, что в v1, — скрипты из
      подписей узлов она вырезает сама.
    -->
    <div class="tessera-mermaid" contenteditable="false">{@html drawn}</div>
  {/if}

  {#if isMermaid && broken}
    <p class="px-2 pb-2 text-xs text-danger" role="alert">{broken}</p>
  {/if}
</div>
