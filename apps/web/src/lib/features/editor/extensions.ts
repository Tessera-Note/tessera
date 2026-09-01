/**
 * Схема узлов редактора на клиенте.
 *
 * Состав в состав повторяет `services/collab/src/extensions.js`. Это не
 * дублирование ради удобства: схема одна на приложение, и расхождение двух
 * списков — порча содержимого. Узел, которого нет во втором списке, не
 * отвергается, а молча выбрасывается при следующем разборе, и обнаруживается
 * это уже потерей текста.
 *
 * **Отображения узлов сняты.** В `@tessera/editor-ext` они написаны на React:
 * пакет общий с v1, и переписывать его на Svelte значило бы завести вторую
 * схему. Здесь у каждого такого расширения снимается `addNodeView`, и Tiptap
 * рисует узел по его же `renderHTML` — тому самому, которым узел записывается
 * в документ. Правка при этом остаётся: снято рисование, а не сам узел.
 *
 * Что теряется без своих отображений: изменение размера картинки мышью,
 * редакторы диаграмм и полотна. Это работа фазы 8 и записана в
 * `docs/future-roadmap.md`.
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
  Status,
  Subpages,
  TableCell,
  TableHeader,
  TableRow,
  TiptapAudio,
  TiptapImage,
  TiptapPdf,
  TiptapVideo,
  TrailingNode,
  TransclusionReference,
  TransclusionSource,
  UniqueID
} from '@tessera/editor-ext';
import { common, createLowlight } from 'lowlight';
import type { AnyExtension } from '@tiptap/core';

/**
 * Снять отображение узла.
 *
 * `addNodeView` в общем пакете возвращает React-представление. Присвоение
 * `undefined` убирает сам хук, и Tiptap рисует узел разметкой из `renderHTML`.
 */
function withoutNodeView<T extends { extend: (config: object) => T }>(extension: T): T {
  return extension.extend({ addNodeView: undefined });
}

/** Расширения, у которых отображение написано на React. */
const REACT_VIEWS = [
  TiptapImage,
  TiptapVideo,
  TiptapAudio,
  TiptapPdf,
  Drawio,
  Excalidraw,
  Embed,
  Mention,
  Subpages,
  Status,
  BaseEmbed,
  TransclusionReference
];

const [
  Image,
  Video,
  Audio,
  Pdf,
  DrawioNode,
  ExcalidrawNode,
  EmbedNode,
  MentionNode,
  SubpagesNode,
  StatusNode,
  BaseEmbedNode,
  TransclusionReferenceNode
] = REACT_VIEWS.map((one) => withoutNodeView(one as never)) as never[];

/**
 * Полный состав расширений.
 *
 * Порядок и настройки повторяют серверный список: `StarterKit` с выключенными
 * блоком кода, ссылкой, замыкающим узлом и заголовком — все четыре заменены
 * своими.
 */
export function editorExtensions(): AnyExtension[] {
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
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Superscript,
    Subscript,
    Highlight.configure({ multicolor: true }),
    Typography,
    TrailingNode,
    TextStyle,
    Color,
    LinkExtension.configure({ openOnClick: false }),
    Youtube,
    Image,
    Video,
    Audio,
    Pdf,
    CustomTable,
    TableCell,
    TableRow,
    TableHeader,
    MathInline,
    MathBlock,
    Details,
    DetailsSummary,
    DetailsContent,
    Callout,
    Attachment,
    CustomCodeBlock.configure({
      // Подсветка синтаксиса нужна самому расширению: без набора языков оно
      // отказывается собираться, и редактор не открывается вовсе.
      lowlight: createLowlight(common),
      enableTabIndentation: true,
      tabSize: 2,
      HTMLAttributes: { spellcheck: false }
    }),
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
    TransclusionSource,
    TransclusionReferenceNode,
    BaseEmbedNode
  ] as AnyExtension[];
}
