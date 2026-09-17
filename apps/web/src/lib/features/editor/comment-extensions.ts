/**
 * Схема комментария.
 *
 * Своя и заметно короче страничной. Комментарий это несколько абзацев с
 * упоминаниями и ссылками, а не документ: таблице, врезке или встроенной базе
 * в нём делать нечего, и предлагать их значило бы обещать то, чего сервер в
 * теле комментария не ждёт.
 *
 * Состав тот же, что в первой версии: `StarterKit` без своей ссылки, ссылка
 * из общего пакета и упоминание. Упоминание берётся оттуда же, что и у
 * страницы, — узел один, и вторая его запись расходилась бы с первой.
 */

import { StarterKit } from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import { LinkExtension, Mention } from '@tessera/editor-ext';
import type { AnyExtension } from '@tiptap/core';
import { svelteNodeView } from './node-view.svelte';
import MentionView from './views/MentionView.svelte';

const MentionNode = (Mention as never as { extend: (config: object) => unknown }).extend({
  addNodeView: () => svelteNodeView(MentionView as never, { inline: true })
});

export function commentExtensions(placeholder: string): AnyExtension[] {
  return [
    StarterKit.configure({
      link: false,
      // Курсоры перетаскивания в поле на три строки только мешают: тащить
      // внутрь комментария нечего.
      gapcursor: false,
      dropcursor: false
    }),
    Placeholder.configure({ placeholder }),
    LinkExtension.configure({ openOnClick: false }),
    MentionNode
  ] as AnyExtension[];
}
