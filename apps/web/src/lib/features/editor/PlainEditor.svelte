<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import {
    IconBlockquote,
    IconBold,
    IconCode,
    IconH1,
    IconH2,
    IconH3,
    IconItalic,
    IconList,
    IconListCheck,
    IconListNumbers,
    IconMinus,
    IconPlus,
    IconSourceCode,
    IconStrikethrough
  } from '@tabler/icons-svelte';
  import type { ComponentType } from 'svelte';
  import type { Editor as TiptapEditor } from '@tiptap/core';
  import { locale } from '$lib/stores/i18n.svelte';
  import { pagelessBlocks } from './blocks';
  import { EMOJI, MENTION, SLASH } from './suggest';
  import { Suggest } from './menus/suggest.svelte';
  import InsertMenu from './menus/InsertMenu.svelte';
  import SuggestMenu from './menus/SuggestMenu.svelte';

  type Props = {
    /** Начальное содержимое. Дальше документ живёт внутри редактора. */
    initial: unknown;
    spaceId?: string | null;
    userId?: string | null;
    fail: (error: unknown) => void;
  };
  const { initial, spaceId = null, userId = null, fail }: Props = $props();

  const t = $derived(locale.t);

  let host: HTMLDivElement;
  let editor: TiptapEditor | null = null;
  let ready = $state<TiptapEditor | null>(null);
  let ticks = $state(0);
  let suggest = $state<Suggest | null>(null);
  let inserting = $state<{ left: number; top: number; bottom: number } | null>(null);

  /** Что набрано. Отдаётся вызовом: документ живёт внутри редактора. */
  export function content(): unknown {
    return editor?.getJSON() ?? null;
  }

  function active(name: string, attributes?: Record<string, unknown>): boolean {
    void ticks;
    return ready?.isActive(name, attributes) ?? false;
  }

  onMount(() => {
    let cancelled = false;

    void (async () => {
      // Библиотека грузится по требованию: она весит сотни килобайт, а на
      // страницах без правки не нужна вовсе. Набор расширений — с ней: обычный
      // импорт затянул бы его в отрисовку на сервере, а там пакет на CommonJS
      // падает с `require is not defined` и роняет страницу целиком.
      const [{ Editor }, { editorExtensions }] = await Promise.all([
        import('@tiptap/core'),
        import('./extensions')
      ]);
      if (cancelled) return;

      const made = new Editor({
        element: host,
        // Совместной правки здесь нет намеренно: у шаблона нет документа Yjs,
        // его правит один человек и сохраняет кнопкой.
        extensions: editorExtensions((key, values) => t(key, values)),
        content: (untrack(() => initial) as never) ?? undefined,
        editorProps: {
          attributes: { class: 'tessera-doc focus:outline-none', 'data-component': 'PlainEditor' }
        }
      });
      editor = made;
      ready = made;

      suggest = new Suggest({
        editor: made,
        // Страницы нет: перечень блоков урезан ровно поэтому.
        pageId: '',
        spaceId,
        userId,
        locale: locale.current,
        translate: (key) => t(key),
        fail,
        rules: [SLASH, MENTION, EMOJI],
        blocks: pagelessBlocks()
      });

      // Вне отслеживания, как и в `Editor.svelte`: обработчик выполняется
      // прямо из `editor.commands.*`, а те зовутся из эффектов. Без `untrack`
      // правка состояния читалась бы от имени вызвавшего эффекта, и он
      // оказывался бы подписан на то, что сам же пишет.
      made.on('transaction', () => {
        untrack(() => {
          ticks += 1;
          suggest?.refresh();
        });
      });
      made.view.dom.addEventListener('keydown', keydown, true);
    })();

    return () => {
      cancelled = true;
    };
  });

  function keydown(event: KeyboardEvent) {
    if (suggest?.keydown(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  onDestroy(() => {
    editor?.view.dom.removeEventListener('keydown', keydown, true);
    editor?.destroy();
  });
</script>

{#snippet action(
  Icon: ComponentType,
  label: string,
  name: string | null,
  run: () => void,
  attributes?: Record<string, unknown>
)}
  {@const on = name ? active(name, attributes) : false}
  <button
    class="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
    class:bg-surface-active={on}
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={on}
    onclick={run}
  >
    <Icon size={17} stroke={1.7} />
  </button>
{/snippet}

<div data-component="PlainEditorFrame">
  {#if ready}
    <div class="mb-3 flex flex-wrap items-center gap-0.5 border-b border-border pb-2">
      {@render action(IconBold, t('Bold'), 'bold', () => ready?.chain().focus().toggleBold().run())}
      {@render action(IconItalic, t('Italic'), 'italic', () =>
        ready?.chain().focus().toggleItalic().run()
      )}
      {@render action(IconStrikethrough, t('Strike'), 'strike', () =>
        ready?.chain().focus().toggleStrike().run()
      )}
      {@render action(IconCode, t('Code'), 'code', () => ready?.chain().focus().toggleCode().run())}

      <span class="mx-1 h-5 w-px bg-border"></span>

      {@render action(
        IconH1,
        t('Heading 1'),
        'heading',
        () => ready?.chain().focus().toggleHeading({ level: 1 }).run(),
        { level: 1 }
      )}
      {@render action(
        IconH2,
        t('Heading 2'),
        'heading',
        () => ready?.chain().focus().toggleHeading({ level: 2 }).run(),
        { level: 2 }
      )}
      {@render action(
        IconH3,
        t('Heading 3'),
        'heading',
        () => ready?.chain().focus().toggleHeading({ level: 3 }).run(),
        { level: 3 }
      )}

      <span class="mx-1 h-5 w-px bg-border"></span>

      {@render action(IconList, t('Bullet list'), 'bulletList', () =>
        ready?.chain().focus().toggleBulletList().run()
      )}
      {@render action(IconListNumbers, t('Numbered list'), 'orderedList', () =>
        ready?.chain().focus().toggleOrderedList().run()
      )}
      {@render action(IconListCheck, t('To-do list'), 'taskList', () =>
        ready?.chain().focus().toggleTaskList().run()
      )}
      {@render action(IconBlockquote, t('Quote'), 'blockquote', () =>
        ready?.chain().focus().toggleBlockquote().run()
      )}
      {@render action(IconSourceCode, t('Code block'), 'codeBlock', () =>
        ready?.chain().focus().toggleCodeBlock().run()
      )}
      {@render action(IconMinus, t('Divider'), 'horizontalRule', () =>
        ready?.chain().focus().setHorizontalRule().run()
      )}

      <span class="mx-1 h-5 w-px bg-border"></span>

      <button
        class="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
        type="button"
        title={t('Insert block')}
        aria-label={t('Insert block')}
        onclick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          inserting = { left: box.left, top: box.top, bottom: box.bottom };
        }}
      >
        <IconPlus size={17} stroke={1.7} />
      </button>
    </div>
  {/if}

  <div bind:this={host}></div>

  {#if ready && inserting}
    <InsertMenu
      editor={ready}
      pageId=""
      at={inserting}
      blocks={pagelessBlocks()}
      {fail}
      onclose={() => (inserting = null)}
    />
  {/if}

  {#if suggest?.open}
    <SuggestMenu
      items={suggest.items}
      index={suggest.index}
      at={suggest.at}
      loading={suggest.loading}
      empty={suggest.empty}
      onpick={(_item, at) => suggest?.pick(at)}
      onhover={(at) => suggest?.hover(at)}
    />
  {/if}
</div>
