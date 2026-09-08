<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import { locale } from '$lib/stores/i18n.svelte';
  import { commentExtensions } from './comment-extensions';
  import { Suggest } from './menus/suggest.svelte';
  import { EMOJI, MENTION } from './suggest';
  import SuggestMenu from './menus/SuggestMenu.svelte';

  type Props = {
    /** Тело комментария документом. Читается наружу через `content()`. */
    initial?: unknown;
    placeholder?: string;
    spaceId?: string | null;
    userId?: string | null;
    fail: (error: unknown) => void;
    /** Отправить по Ctrl+Enter, как в v1. */
    onsubmit?: () => void;
  };
  const { initial, placeholder, spaceId = null, userId = null, fail, onsubmit }: Props = $props();

  const t = $derived(locale.t);

  let host: HTMLDivElement;
  let editor: Editor | null = null;
  let suggest = $state<Suggest | null>(null);
  /** Редактор собран: до этого читать из него нечего. */
  let ready = $state(false);

  /**
   * Тело комментария документом.
   *
   * Наружу отдаётся вызовом, а не привязкой: документ живёт внутри редактора,
   * и его копия в состоянии Svelte означала бы две правды об одном тексте.
   */
  export function content(): unknown {
    return editor?.getJSON() ?? null;
  }

  /** Пусто ли поле. По нему решается, показывать ли кнопку отправки. */
  export function isEmpty(): boolean {
    return editor?.isEmpty ?? true;
  }

  /** Очистить поле после отправки. */
  export function clear(): void {
    editor?.commands.clearContent(true);
  }

  onMount(() => {
    let cancelled = false;

    void (async () => {
      // Библиотека редактора грузится по требованию: на странице без
      // обсуждения она не нужна вовсе.
      const { Editor } = await import('@tiptap/core');
      if (cancelled) return;

      const made = new Editor({
        element: host,
        extensions: commentExtensions(placeholder ?? t('Write a comment')),
        content: (untrack(() => initial) as never) ?? undefined,
        editorProps: {
          attributes: {
            class: 'tessera-comment focus:outline-none',
            'data-component': 'CommentEditor'
          }
        }
      });
      editor = made;
      ready = true;

      suggest = new Suggest({
        editor: made,
        // Вложения и базы к комментарию не привязываются: страница нужна
        // подбору только для поиска страниц при упоминании.
        pageId: '',
        spaceId,
        userId,
        locale: locale.current,
        translate: (key) => t(key),
        fail,
        rules: [MENTION, EMOJI]
      });

      // Вне отслеживания по той же причине, что и в `Editor.svelte`: подбор
      // правит своё состояние, а обработчик выполняется внутри вызова команды.
      made.on('transaction', () => untrack(() => suggest?.refresh()));
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
      return;
    }
    // Отправка сочетанием: Enter внутри поля заводит абзац, и отнимать его
    // нельзя — комментарий бывает длиннее строки.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onsubmit?.();
    }
  }

  onDestroy(() => {
    editor?.view.dom.removeEventListener('keydown', keydown, true);
    editor?.destroy();
  });
</script>

<div
  bind:this={host}
  class="min-h-16 rounded border border-border bg-surface px-3 py-2 text-sm"
></div>

{#if ready && suggest?.open}
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
