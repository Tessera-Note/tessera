/**
 * Markdown в буфере обмена.
 *
 * Два предмета. Первый: скопированный список уходит в буфер как Markdown, а не
 * как голый текст — иначе перенос списка в другое приложение теряет и уровни,
 * и нумерацию. Второй: вставленный простой текст разбирается как Markdown,
 * потому что чаще всего он им и является — заметка из редактора кода, кусок
 * README, ответ помощника.
 *
 * Перенесено из v1 (`extensions/markdown-clipboard.ts`, само взято из
 * tiptap-markdown, MIT). Отличие одно: распознавание одиночной ссылки написано
 * своё — библиотека распознавания в составе зависимостей проекта не объявлена.
 */

import { Extension } from '@tiptap/core';
import { htmlToMarkdown, markdownToHtml } from '@tessera/editor-ext';
import { DOMParser, DOMSerializer, Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { isBareLink, normalizeTableColumnWidths } from './table-widths';

export type MarkdownClipboardOptions = {
  /** Разбирать ли вставленный простой текст как Markdown. */
  transformPastedText: boolean;
};

/** Разобрать строку разметки в узел документа, сохранив крайние пробелы. */
function elementFromString(value: string): HTMLElement {
  return new window.DOMParser().parseFromString(`<body>${value}</body>`, 'text/html').body;
}

const LIST_TYPES = ['bulletList', 'orderedList', 'taskList'];

export const MarkdownClipboard = Extension.create<MarkdownClipboardOptions>({
  name: 'markdownClipboard',
  // Раньше разбора вставленного: иначе текст успевает стать абзацами.
  priority: 101,

  addOptions() {
    return { transformPastedText: false };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('markdownClipboard'),
        props: {
          clipboardTextSerializer: (slice) => {
            // Markdown кладётся в буфер только за список из нескольких строк.
            // Одна строка и так переносится верно, а Markdown вместо неё
            // означал бы звёздочки в почте и в мессенджере.
            let count = 0;
            let list = false;
            slice.content.forEach((node) => {
              if (LIST_TYPES.includes(node.type.name)) {
                list = true;
                count += node.childCount;
              } else {
                count += 1;
              }
            });
            // Не список — отдаём то же, что отдал бы редактор сам: узлы
            // текстом через пустую строку. Возврат пустоты здесь означал бы
            // пустой буфер, а не «сделай как обычно».
            if (!list || count < 2) {
              return slice.content.textBetween(0, slice.content.size, '\n\n');
            }

            const box = document.createElement('div');
            box.appendChild(
              DOMSerializer.fromSchema(this.editor.schema).serializeFragment(slice.content)
            );
            return htmlToMarkdown(box.innerHTML);
          },

          handlePaste: (view, event) => {
            if (!event.clipboardData) return false;
            // В блоке кода вставленное это текст программы, а не разметка.
            if (this.editor.isActive('codeBlock')) return false;

            const text = event.clipboardData.getData('text/plain');
            const html = event.clipboardData.getData('text/html');
            const editor = event.clipboardData.getData('vscode-editor-data');
            const known = editor ? (JSON.parse(editor) as { mode?: string }) : undefined;

            const fromMarkdownEditor = known?.mode === 'markdown';
            const plainOnly = !html && !editor && Boolean(text);
            if (!fromMarkdownEditor && !plainOnly) return false;

            if (plainOnly) {
              // Shift при вставке означает «как есть», без разбора.
              const shift = (view as unknown as { input?: { shiftKey?: boolean } }).input?.shiftKey;
              if (shift || !this.options.transformPastedText) return false;
              if (isBareLink(text)) return false;
            }

            const { tr } = view.state;
            const { from, to } = view.state.selection;

            // Разбор объявлен возвращающим то ли строку, то ли обещание;
            // настоящий возвращает строку. Обещание сюда не годится: вставка
            // разбирается синхронно, вернуть управление и дописать позже
            // значило бы вставить в уже сдвинувшийся документ.
            const parsedHtml = markdownToHtml(text.replace(/\n+$/, ''));
            if (typeof parsedHtml !== 'string') return false;

            const body = elementFromString(parsedHtml);
            normalizeTableColumnWidths(body);

            const parsed = DOMParser.fromSchema(this.editor.schema).parseSlice(body, {
              preserveWhitespace: true
            });

            tr.replaceRange(from, to, parsed);
            const end = tr.mapping.map(from, 1);
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(from, end - 2)), -1));
            tr.setMeta('paste', true);
            view.dispatch(tr);
            return true;
          },

          /**
           * Срезать пустые абзацы в хвосте вставленного.
           *
           * Терминалы кладут в разметку буфера завершающие пробелы, и разбор
           * делает из них лишний абзац. Внутри пункта списка он превращается в
           * пустую строку, разрывающую список.
           */
          transformPasted: (slice) => {
            let content = slice.content;
            while (content.childCount > 1) {
              const last = content.lastChild;
              if (last?.type.name !== 'paragraph' || last.textContent.trim() !== '') break;
              const kept = [];
              for (let i = 0; i < content.childCount - 1; i += 1) kept.push(content.child(i));
              content = Fragment.from(kept);
            }

            if (content === slice.content) return slice;
            return new Slice(content, slice.openStart, Math.max(slice.openEnd, 1));
          }
        }
      })
    ];
  }
});
