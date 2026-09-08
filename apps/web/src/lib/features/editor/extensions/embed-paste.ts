/**
 * Ссылка на ролик превращается в сам ролик.
 *
 * Вставленный адрес YouTube раньше оставался ссылкой: смотреть приходилось на
 * стороннем сайте, уходя со страницы. Готовое правило вставки у расширения
 * `@tiptap/extension-youtube` до этого места не доходит — разбор буфера обмена
 * стоит раньше и ссылку забирает, — поэтому распознавание здесь и со старшим
 * приоритетом.
 *
 * Разбор адреса берётся общий (`getEmbedUrlAndProvider` из пакета расширений):
 * тот же, каким пользуется сам узел встраивания. Своё распознавание означало бы
 * два списка служб, которые разойдутся.
 */

import { Extension } from '@tiptap/core';
import { getEmbedUrlAndProvider } from '@tessera/editor-ext';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Ролик, который стоит показать проигрывателем.
 *
 * `iframe` — ответ разбора «служба не опознана», и такую ссылку трогать нельзя:
 * иначе любой вставленный адрес превращался бы во встроенное окно вместо
 * обычной ссылки.
 */
export function embedFromLink(raw: string): { src: string; provider: string } | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;

  try {
    const address = new URL(text);
    if (address.protocol !== 'http:' && address.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  const found = getEmbedUrlAndProvider(text);
  if (!found || found.provider === 'iframe') return null;
  return { src: found.embedUrl, provider: found.provider };
}

export const EmbedPaste = Extension.create({
  name: 'embedPaste',
  // Больше, чем у разбора буфера как Markdown (101): тот забирает вставку
  // первым и до правил вставки ссылку не доводит.
  priority: 120,

  addProseMirrorPlugins() {
    const { editor } = this;

    return [
      new Plugin({
        key: new PluginKey('embedPaste'),
        props: {
          handlePaste: (_view, event) => {
            if (!event.clipboardData) return false;
            // В блоке кода вставленное — текст программы, а не адрес.
            if (editor.isActive('codeBlock')) return false;
            // Разметка из буфера разбирается своим путём: она может нести и
            // ссылку, и текст вокруг неё.
            if (event.clipboardData.getData('text/html')) return false;

            const found = embedFromLink(event.clipboardData.getData('text/plain'));
            if (!found) return false;

            return editor
              .chain()
              .focus()
              .setEmbed({ provider: found.provider, src: found.src })
              .run();
          }
        }
      })
    ];
  }
});
