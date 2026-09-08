/**
 * Срезание чужих стилей при вставке.
 *
 * Вставленное из Word, Google Docs и почтового письма несёт `style` на каждом
 * теге: свои шрифты, свои цвета, свои отступы. В документе они переживают и
 * смену темы, и вывоз, и выглядят как поломка вёрстки страницы, а не как
 * оформление вставленного.
 *
 * Правило то же, что в v1, вплоть до приоритета: расширение должно отработать
 * до разбора вставленного в узлы.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const CleanStyles = Extension.create({
  name: 'cleanStyles',
  priority: 80,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('cleanStyles'),
        props: {
          transformPastedHTML(html) {
            return html.replace(/\s+style="[^"]*"/gi, '');
          }
        }
      })
    ];
  }
});
