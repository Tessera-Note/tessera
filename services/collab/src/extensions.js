/**
 * The editor node schema — one for the whole product.
 *
 * The list was carried over from the earlier version item for item rather than
 * written anew.
 *
 * A second list would mean two schemas obliged to match. A divergence between
 * the schemas is content corruption, and it does not show up at once: the
 * document is saved, and a node missing from the second schema is dropped
 * silently on the next parse.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { StarterKit } = require('@tiptap/starter-kit');
const { TextAlign } = require('@tiptap/extension-text-align');
const { Superscript } = require('@tiptap/extension-superscript');
const SubScript = require('@tiptap/extension-subscript').default;
const { Typography } = require('@tiptap/extension-typography');
const { TextStyle } = require('@tiptap/extension-text-style');
const { Color } = require('@tiptap/extension-color');
const { Youtube } = require('@tiptap/extension-youtube');
const { TaskList, TaskItem } = require('@tiptap/extension-list');
const {
  Heading,
  Callout,
  Comment,
  CustomCodeBlock,
  Details,
  DetailsContent,
  DetailsSummary,
  LinkExtension,
  MathBlock,
  MathInline,
  TableHeader,
  TableCell,
  TableRow,
  CustomTable,
  TiptapImage,
  TiptapVideo,
  TiptapAudio,
  TiptapPdf,
  PageBreak,
  TrailingNode,
  Attachment,
  Drawio,
  Excalidraw,
  Embed,
  Mention,
  Subpages,
  Highlight,
  Indent,
  UniqueID,
  Columns,
  Column,
  Status,
  addUniqueIdsToDoc,
  htmlToMarkdown,
  markdownToHtml,
  TransclusionSource,
  TransclusionReference,
  BaseEmbed,
} = require('@tessera/editor-ext');

export const tiptapExtensions = [
  StarterKit.configure({
    codeBlock: false,
    link: false,
    trailingNode: false,
    heading: false,
  }),
  Heading,
  UniqueID.configure({
    types: ['heading', 'paragraph', 'transclusionSource'],
  }),
  Comment,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Superscript,
  SubScript,
  Highlight.configure({ multicolor: true }),
  Typography,
  TrailingNode,
  TextStyle,
  Color,
  LinkExtension.configure({ openOnClick: false }),
  Youtube,
  TiptapImage,
  TiptapVideo,
  TiptapAudio,
  TiptapPdf,
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
  CustomCodeBlock,
  Drawio,
  Excalidraw,
  Embed,
  Mention,
  Subpages,
  Columns,
  Column,
  Status,
  Indent,
  PageBreak,
  TransclusionSource,
  TransclusionReference,
  BaseEmbed,
];

export { addUniqueIdsToDoc, htmlToMarkdown, markdownToHtml };
