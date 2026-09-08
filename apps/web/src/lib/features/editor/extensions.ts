/**
 * Схема узлов редактора на клиенте.
 *
 * Состав в состав повторяет `services/collab/src/extensions.js`. Это не
 * дублирование ради удобства: схема одна на приложение, и расхождение двух
 * списков — порча содержимого. Узел, которого нет во втором списке, не
 * отвергается, а молча выбрасывается при следующем разборе, и обнаруживается
 * это уже потерей текста.
 *
 * **Отображения узлов свои.** В `@tessera/editor-ext` они написаны на React:
 * пакет общий с v1, и переписывать его на Svelte значило бы завести вторую
 * схему узлов. Поэтому расширение берётся как есть, а `addNodeView` заменяется
 * на рисование Svelte (`withView`). Меняется только рисование — сам узел,
 * его атрибуты и правила разбора остаются теми же.
 *
 * Узлу, которому своё рисование не нужно, оно снимается (`withoutNodeView`), и
 * Tiptap показывает его по `renderHTML` — тому самому, которым узел
 * записывается в документ.
 */

import { StarterKit } from '@tiptap/starter-kit';
import { TextAlign } from '@tiptap/extension-text-align';
import { Superscript } from '@tiptap/extension-superscript';
import Subscript from '@tiptap/extension-subscript';
import { Typography } from '@tiptap/extension-typography';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { Youtube } from '@tiptap/extension-youtube';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import {
  Attachment,
  BaseEmbed,
  Callout,
  Column,
  Columns,
  Comment,
  CustomCodeBlock,
  CustomTable,
  Details,
  DetailsContent,
  DetailsSummary,
  Drawio,
  Embed,
  Excalidraw,
  Heading,
  Highlight,
  Indent,
  LinkExtension,
  MathBlock,
  MathInline,
  Mention,
  PageBreak,
  SearchAndReplace,
  Status,
  Subpages,
  TableCell,
  TableDndExtension,
  TableHandleCommandsExtension,
  TableHeader,
  TableHeaderPin,
  TableReadonlySort,
  TableRow,
  TableView,
  TiptapAudio,
  TiptapImage,
  TiptapPdf,
  TiptapVideo,
  TrailingNode,
  TransclusionReference,
  TransclusionSource,
  UniqueID
} from '@tessera/editor-ext';
import { CharacterCount, Placeholder, Selection } from '@tiptap/extensions';
import clojure from 'highlight.js/lib/languages/clojure';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import elixir from 'highlight.js/lib/languages/elixir';
import erlang from 'highlight.js/lib/languages/erlang';
import fortran from 'highlight.js/lib/languages/fortran';
import haskell from 'highlight.js/lib/languages/haskell';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import scala from 'highlight.js/lib/languages/scala';
import { common, createLowlight } from 'lowlight';
import { AutoJoiner } from './extensions/auto-joiner';
import { CleanStyles } from './extensions/clean-styles';
import { MarkdownClipboard } from './extensions/markdown-clipboard';
import type { AnyExtension, Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Component } from 'svelte';
import { svelteNodeView, type NodeViewProps } from './node-view.svelte';
import BaseEmbedView from './views/BaseEmbedView.svelte';
import DiagramView from './views/DiagramView.svelte';
import MediaView from './views/MediaView.svelte';
import MentionView from './views/MentionView.svelte';
import AttachmentView from './views/AttachmentView.svelte';
import CodeBlockView from './views/CodeBlockView.svelte';
import CalloutView from './views/CalloutView.svelte';
import MathView from './views/MathView.svelte';
import StatusView from './views/StatusView.svelte';
import SubpagesView from './views/SubpagesView.svelte';
import TransclusionReferenceView from './views/TransclusionReferenceView.svelte';
import TransclusionSourceView from './views/TransclusionSourceView.svelte';

/**
 * Подменить отображение узла своим.
 *
 * В общем пакете `addNodeView` возвращает представление на React. Здесь оно
 * заменяется на Svelte: схема узла остаётся той же — меняется только рисование.
 */
function withView<T extends { extend: (config: object) => T }>(
  extension: T,
  view: Component<NodeViewProps>,
  options: { inline?: boolean; content?: boolean; extra?: Record<string, unknown> } = {}
): T {
  return extension.extend({ addNodeView: () => svelteNodeView(view, options) });
}

/**
 * Снять отображение узла.
 *
 * Присвоение `undefined` убирает сам хук, и Tiptap рисует узел разметкой из
 * `renderHTML`. Так остаются узлы, которым отдельное рисование не нужно.
 */
function withoutNodeView<T extends { extend: (config: object) => T }>(extension: T): T {
  return extension.extend({ addNodeView: undefined });
}

/** Узлы со своим отображением: без него они не показывают содержимого. */
const Image = withView(TiptapImage as never, MediaView as never, { extra: { kind: 'image' } });
const Video = withView(TiptapVideo as never, MediaView as never, { extra: { kind: 'video' } });
const Audio = withView(TiptapAudio as never, MediaView as never, { extra: { kind: 'audio' } });
const Pdf = withView(TiptapPdf as never, MediaView as never, { extra: { kind: 'pdf' } });
const DrawioNode = withView(Drawio as never, DiagramView as never, {
  extra: { kind: 'drawio' }
});
const ExcalidrawNode = withView(Excalidraw as never, DiagramView as never, {
  extra: { kind: 'excalidraw' }
});
const MentionNode = withView(Mention as never, MentionView as never, { inline: true });
const SubpagesNode = withView(Subpages as never, SubpagesView as never);
const StatusNode = withView(Status as never, StatusView as never, { inline: true });
const BaseEmbedNode = withView(BaseEmbed as never, BaseEmbedView as never);
/** Выноска: значок и цвет по виду, содержимое правит сам редактор. */
const CalloutNode = withView(Callout as never, CalloutView as never, { content: true });
const AttachmentNode = withView(Attachment as never, AttachmentView as never);

/**
 * Подсветка нужна самому расширению: без набора языков оно отказывается
 * собираться. Тот же набор отдаётся отображению — списка языков у него своего
 * нет, и второй список разошёлся бы с первым.
 */
const lowlight = createLowlight(common);

/**
 * Языки сверх общего набора. Перечень тот же, что в v1: страница, привезённая
 * оттуда, должна подсвечиваться так же.
 *
 * `mermaid` объявлен обычным текстом намеренно: это не язык подсветки, а
 * пометка для отображения блока, и без объявления `lowlight` не знает, что с
 * ним делать.
 */
for (const [name, language] of [
  ['mermaid', plaintext],
  ['powershell', powershell],
  ['erlang', erlang],
  ['elixir', elixir],
  ['dockerfile', dockerfile],
  ['clojure', clojure],
  ['fortran', fortran],
  ['haskell', haskell],
  ['scala', scala]
] as const) {
  lowlight.register(name, language);
}

const CodeBlockNode = withView(
  CustomCodeBlock.configure({
    lowlight,
    enableTabIndentation: true,
    tabSize: 2,
    HTMLAttributes: { spellcheck: false }
  }) as never,
  CodeBlockView as never,
  { content: true, extra: { languages: () => lowlight.listLanguages() } }
);

/**
 * Формула. Отображение одно на оба узла: разница между строчной и блочной —
 * это довод `displayMode` у KaTeX и место, где стоит окно правки.
 */
const MathInlineNode = withView(MathInline as never, MathView as never, {
  inline: true,
  extra: { display: false }
});
const MathBlockNode = withView(MathBlock as never, MathView as never, {
  extra: { display: true }
});

/**
 * Встраивание внешнего ролика рисуется своей разметкой: показывать там нечего
 * сверх того, что записано в узле.
 */
const EmbedNode = withoutNodeView(Embed as never);

/**
 * Включения. У блока-источника содержимое правит сам редактор, поэтому его
 * отображение только обрамляет; у ссылки содержимого нет вовсе — она
 * спрашивает его у источника.
 */
const TransclusionSourceNode = withView(
  TransclusionSource as never,
  TransclusionSourceView as never,
  {
    content: true
  }
);
const TransclusionReferenceNode = withView(
  TransclusionReference as never,
  TransclusionReferenceView as never
);

/**
 * Полный состав расширений.
 *
 * Порядок и настройки повторяют серверный список: `StarterKit` с выключенными
 * блоком кода, ссылкой, замыкающим узлом и заголовком — все четыре заменены
 * своими.
 */
/**
 * Как перевести подсказку.
 *
 * Отдельным доводом, а не обращением к хранилищу языка: перечень расширений
 * собирается один раз на редактор и хранилища не знает, а подсказки нужны
 * только там, где есть правка.
 */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Подсказка в пустом узле.
 *
 * Разная по месту: в ячейке таблицы, в колонке, в выноске и в цитате места на
 * длинную фразу нет, а «/» там работает так же — но подсказка в каждой ячейке
 * пустой таблицы превращала бы её в стену текста.
 */
function placeholderFor(translate: Translate) {
  return ({ editor, node, pos }: { editor: Editor; node: PMNode; pos: number }): string => {
    if (node.type.name === 'heading') {
      return translate('Heading {{level}}', { level: node.attrs.level });
    }
    if (node.type.name === 'detailsSummary') return translate('Toggle title');
    if (node.type.name !== 'paragraph') return '';

    const inside = editor.state.doc.resolve(pos).parent.type.name;
    if (['column', 'tableCell', 'tableHeader', 'callout', 'blockquote'].includes(inside)) {
      return translate('Write...');
    }
    return translate('Write anything. Enter "/" for commands');
  };
}

export function editorExtensions(translate: Translate = (key) => key): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      link: false,
      trailingNode: false,
      heading: false,
      // История берётся у совместного редактирования: две истории на один
      // документ отменяют чужие правки как свои.
      undoRedo: false
    }),
    Heading,
    UniqueID.configure({ types: ['heading', 'paragraph', 'transclusionSource'] }),
    Comment,
    Placeholder.configure({
      placeholder: placeholderFor(translate),
      includeChildren: true,
      // В чтении подсказки не показываются: заполнять читателю нечего.
      showOnlyWhenEditable: true
    }),
    // Украшение выделения, когда редактор потерял фокус. Без него выделенное
    // пропадает с глаз, стоит нажать на кнопку панели, и человек не видит, к
    // чему она применится.
    Selection,
    // Счёт слов и знаков для боковой панели страницы. Своего счёта у панели
    // нет: он идёт по документу редактора, а не по разметке.
    CharacterCount,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Superscript,
    Subscript,
    Highlight.configure({ multicolor: true }),
    Typography,
    // Слияние соседних списков: без него отмена правки и вставка между
    // списками оставляют два вплотную, и нумерация начинается заново.
    AutoJoiner,
    // Срезание чужих стилей при вставке из Word и почты.
    CleanStyles,
    // Разбор вставленного простого текста как Markdown и копирование списка
    // Markdown'ом.
    MarkdownClipboard.configure({ transformPastedText: true }),
    TrailingNode,
    TextStyle,
    Color,
    LinkExtension.configure({ openOnClick: false }),
    Youtube,
    Image,
    Video,
    Audio,
    Pdf,
    // Настройки те же, что в v1: ширина ячейки и выделение таблицы узлом
    // участвуют в перетаскивании столбцов, а `View` даёт ту обёртку, к которой
    // цепляются закрепление шапки и сортировка.
    CustomTable.configure({
      resizable: true,
      allowTableNodeSelection: true,
      cellMinWidth: 49,
      View: TableView
    }),
    TableCell,
    TableRow,
    TableHeader,
    // Перетаскивание строк и столбцов, действия у ручки, закрепление шапки и
    // сортировка в чтении. Схему узлов ни одно не трогает: у них нет своих
    // атрибутов, только украшения и разбор нажатий.
    TableDndExtension,
    TableHandleCommandsExtension,
    TableHeaderPin,
    TableReadonlySort,
    MathInlineNode,
    MathBlockNode,
    Details,
    DetailsSummary,
    DetailsContent,
    CalloutNode,
    AttachmentNode,
    CodeBlockNode,
    DrawioNode,
    ExcalidrawNode,
    EmbedNode,
    MentionNode,
    SubpagesNode,
    Columns,
    Column,
    StatusNode,
    Indent,
    PageBreak,
    TransclusionSourceNode,
    TransclusionReferenceNode,
    BaseEmbedNode,
    // Поиск с заменой узлов не заводит: он рисует украшения поверх готового
    // документа. Поэтому в списке `services/collab` его нет и быть не должно —
    // схема от него не меняется, а на сервере рисовать нечего.
    SearchAndReplace
  ] as AnyExtension[];
}
