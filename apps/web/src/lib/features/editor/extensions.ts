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
import type { Component } from 'svelte';
import { svelteNodeView, type NodeViewProps } from './node-view.svelte';
import BaseEmbedView from './views/BaseEmbedView.svelte';
import DiagramView from './views/DiagramView.svelte';
import MediaView from './views/MediaView.svelte';
import MentionView from './views/MentionView.svelte';
import StatusView from './views/StatusView.svelte';
import SubpagesView from './views/SubpagesView.svelte';
import TransclusionReferenceView from './views/TransclusionReferenceView.svelte';
import TransclusionSourceView from './views/TransclusionSourceView.svelte';

/**
 * Один компонент показывает четыре вида вложений: разница между ними в теге, а
 * не в поведении, и четыре почти одинаковых файла разъехались бы.
 */
function mediaView(kind: 'image' | 'video' | 'audio' | 'pdf'): Component<NodeViewProps> {
  return ((anchor: never, props: NodeViewProps) =>
    (MediaView as never as (a: never, p: object) => unknown)(anchor, {
      ...props,
      kind
    })) as never;
}

function diagramView(kind: 'drawio' | 'excalidraw'): Component<NodeViewProps> {
  return ((anchor: never, props: NodeViewProps) =>
    (DiagramView as never as (a: never, p: object) => unknown)(anchor, {
      ...props,
      kind
    })) as never;
}

/**
 * Подменить отображение узла своим.
 *
 * В общем пакете `addNodeView` возвращает представление на React. Здесь оно
 * заменяется на Svelte: схема узла остаётся той же — меняется только рисование.
 */
function withView<T extends { extend: (config: object) => T }>(
  extension: T,
  view: Component<NodeViewProps>,
  options: { inline?: boolean; content?: boolean } = {}
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
const Image = withView(TiptapImage as never, mediaView('image'));
const Video = withView(TiptapVideo as never, mediaView('video'));
const Audio = withView(TiptapAudio as never, mediaView('audio'));
const Pdf = withView(TiptapPdf as never, mediaView('pdf'));
const DrawioNode = withView(Drawio as never, diagramView('drawio'));
const ExcalidrawNode = withView(Excalidraw as never, diagramView('excalidraw'));
const MentionNode = withView(Mention as never, MentionView as never, { inline: true });
const SubpagesNode = withView(Subpages as never, SubpagesView as never);
const StatusNode = withView(Status as never, StatusView as never, { inline: true });
const BaseEmbedNode = withView(BaseEmbed as never, BaseEmbedView as never);

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
    TransclusionSourceNode,
    TransclusionReferenceNode,
    BaseEmbedNode
  ] as AnyExtension[];
}
