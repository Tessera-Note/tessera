<script lang="ts">
  import {
    IconAlignCenter,
    IconAlignJustified,
    IconAlignLeft,
    IconAlignRight,
    IconBold,
    IconCode,
    IconH1,
    IconH2,
    IconH3,
    IconItalic,
    IconLink,
    IconMessagePlus,
    IconPalette,
    IconStrikethrough,
    IconTypography,
    IconUnderline
  } from '@tabler/icons-svelte';
  import type { Editor } from '@tiptap/core';
  import { locale } from '$lib/stores/i18n.svelte';
  import { HIGHLIGHT_COLORS, TEXT_COLORS } from '../colors';

  type Props = {
    editor: Editor;
    /** Счётчик правок: состояние кнопок держит сам редактор. */
    tick: number;
    at: { left: number; top: number; bottom: number };
    onlink: () => void;
    /** Обсудить выделенное. Ставит метку и заводит запись обсуждения. */
    oncomment: () => void;
  };
  const { editor, tick, at, onlink, oncomment }: Props = $props();

  const t = $derived(locale.t);

  /** Открытая вкладка цветов. Закрыта — `null`. */
  let colors = $state(false);

  function active(name: string, attributes?: Record<string, unknown>): boolean {
    void tick;
    return editor.isActive(name, attributes);
  }

  /** Высота меню с запасом на цвета: по ней решается, куда его раскрывать. */
  const HEIGHT = 44;
  const flipped = $derived(at.top > HEIGHT + 8);
</script>

{#snippet action(Icon: typeof IconBold, label: string, run: () => void, on: boolean = false)}
  <button
    class="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
    class:bg-surface-active={on}
    class:text-text={on}
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={on}
    onclick={run}
  >
    <Icon size={17} stroke={1.7} />
  </button>
{/snippet}

<div
  data-component="BubbleMenu"
  class="fixed z-40 rounded-md border border-border bg-surface-raised shadow-lg"
  style:left="{at.left}px"
  style:top={flipped ? 'auto' : `${at.bottom + 8}px`}
  style:bottom={flipped ? `${window.innerHeight - at.top + 8}px` : 'auto'}
>
  <div class="flex items-center gap-0.5 p-1">
    {@render action(
      IconBold,
      t('Bold'),
      () => editor.chain().focus().toggleBold().run(),
      active('bold')
    )}
    {@render action(
      IconItalic,
      t('Italic'),
      () => editor.chain().focus().toggleItalic().run(),
      active('italic')
    )}
    {@render action(
      IconUnderline,
      t('Underline'),
      () => editor.chain().focus().toggleUnderline().run(),
      active('underline')
    )}
    {@render action(
      IconStrikethrough,
      t('Strike'),
      () => editor.chain().focus().toggleStrike().run(),
      active('strike')
    )}
    {@render action(
      IconCode,
      t('Code'),
      () => editor.chain().focus().toggleCode().run(),
      active('code')
    )}

    <span class="mx-1 h-5 w-px bg-border"></span>

    {@render action(
      IconTypography,
      t('Text'),
      () => editor.chain().focus().setNode('paragraph').run(),
      active('paragraph')
    )}
    {@render action(
      IconH1,
      t('Heading 1'),
      () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      active('heading', { level: 1 })
    )}
    {@render action(
      IconH2,
      t('Heading 2'),
      () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      active('heading', { level: 2 })
    )}
    {@render action(
      IconH3,
      t('Heading 3'),
      () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
      active('heading', { level: 3 })
    )}

    <span class="mx-1 h-5 w-px bg-border"></span>

    {@render action(
      IconAlignLeft,
      t('Align left'),
      () => editor.chain().focus().setTextAlign('left').run(),
      active('paragraph', { textAlign: 'left' }) || active('heading', { textAlign: 'left' })
    )}
    {@render action(
      IconAlignCenter,
      t('Align center'),
      () => editor.chain().focus().setTextAlign('center').run(),
      active('paragraph', { textAlign: 'center' }) || active('heading', { textAlign: 'center' })
    )}
    {@render action(
      IconAlignRight,
      t('Align right'),
      () => editor.chain().focus().setTextAlign('right').run(),
      active('paragraph', { textAlign: 'right' }) || active('heading', { textAlign: 'right' })
    )}
    {@render action(
      IconAlignJustified,
      t('Justify'),
      () => editor.chain().focus().setTextAlign('justify').run(),
      active('paragraph', { textAlign: 'justify' }) || active('heading', { textAlign: 'justify' })
    )}

    <span class="mx-1 h-5 w-px bg-border"></span>

    {@render action(IconPalette, t('Color'), () => (colors = !colors), colors)}
    {@render action(IconLink, t('Link'), onlink, active('link'))}
    {@render action(IconMessagePlus, t('Comment'), oncomment)}
  </div>

  {#if colors}
    <div class="border-t border-border p-2">
      <p class="mb-1 text-xs text-text-muted">{t('Text color')}</p>
      <div class="mb-2 flex flex-wrap gap-1">
        {#each TEXT_COLORS as swatch (swatch.name)}
          <button
            class="h-6 w-6 rounded border border-border text-sm font-semibold leading-none"
            type="button"
            title={t(swatch.name)}
            aria-label={t(swatch.name)}
            style:color={swatch.color || undefined}
            onclick={() => {
              const chain = editor.chain().focus();
              if (swatch.color) chain.setColor(swatch.color).run();
              else chain.unsetColor().run();
              colors = false;
            }}
          >
            A
          </button>
        {/each}
      </div>

      <p class="mb-1 text-xs text-text-muted">{t('Background color')}</p>
      <div class="flex flex-wrap gap-1">
        {#each HIGHLIGHT_COLORS as swatch (swatch.name)}
          <button
            class="h-6 w-6 rounded border border-border"
            type="button"
            title={t(swatch.name)}
            aria-label={t(swatch.name)}
            style:background-color={swatch.color || 'transparent'}
            onclick={() => {
              const chain = editor.chain().focus();
              if (swatch.color) chain.setHighlight({ color: swatch.color }).run();
              else chain.unsetHighlight().run();
              colors = false;
            }}
          ></button>
        {/each}
      </div>
    </div>
  {/if}
</div>
