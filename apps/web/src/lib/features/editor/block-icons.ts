/**
 * Значки блоков.
 *
 * Отдельно от перечня (`blocks.ts`) намеренно. Пакет `@tabler/icons-svelte`
 * собран под сборщик: внутри него пути записаны без расширений, и вне Vite он
 * не читается — перечень блоков вместе с ним стал бы непроверяемым. Здесь
 * значки, там опись; расхождение ловит тип, а не внимательность.
 */

import {
  IconAppWindow,
  IconBinaryTree2,
  IconBlockquote,
  IconBrandAirtable,
  IconBrandFramer,
  IconBrandGoogleDrive,
  IconBrandLoom,
  IconBrandVimeo,
  IconBrandYoutube,
  IconCalendar,
  IconCaretRightFilled,
  IconChartDots3,
  IconCheckbox,
  IconClock,
  IconCode,
  IconColumns2,
  IconColumns3,
  IconFileDescription,
  IconFileSpreadsheet,
  IconFileTypePdf,
  IconForms,
  IconH1,
  IconH2,
  IconH3,
  IconInfoCircle,
  IconLayoutBoard,
  IconLayoutColumns,
  IconLayoutKanban,
  IconList,
  IconListNumbers,
  IconMath,
  IconMathFunction,
  IconMenu4,
  IconMovie,
  IconMusic,
  IconPageBreak,
  IconPaperclip,
  IconPhoto,
  IconPresentation,
  IconRotate2,
  IconScribble,
  IconSitemap,
  IconTable,
  IconTag,
  IconTypography
} from '@tabler/icons-svelte';
import type { ComponentType } from 'svelte';
import type { BlockId } from './blocks';

/**
 * Значок на каждое имя блока.
 *
 * `Record<BlockId, …>` требует всех имён и не терпит лишних: новый блок без
 * значка и значок без блока это отказ сборки, а не пустое место на экране.
 */
const BLOCK_ICONS: Record<BlockId, ComponentType> = {
  text: IconTypography,
  heading1: IconH1,
  heading2: IconH2,
  heading3: IconH3,
  bulletList: IconList,
  orderedList: IconListNumbers,
  taskList: IconCheckbox,
  blockquote: IconBlockquote,
  codeBlock: IconCode,
  horizontalRule: IconMenu4,
  pageBreak: IconPageBreak,
  table: IconTable,
  details: IconCaretRightFilled,
  callout: IconInfoCircle,
  mathInline: IconMathFunction,
  mathBlock: IconMath,
  status: IconTag,
  subpages: IconSitemap,
  transclusion: IconRotate2,
  columns2: IconColumns2,
  columns3: IconColumns3,
  columns4: IconLayoutColumns,
  columns5: IconLayoutColumns,
  date: IconCalendar,
  time: IconClock,
  image: IconPhoto,
  video: IconMovie,
  audio: IconMusic,
  pdf: IconFileTypePdf,
  attachment: IconPaperclip,
  mermaid: IconChartDots3,
  drawio: IconBinaryTree2,
  excalidraw: IconScribble,
  base: IconTable,
  kanban: IconLayoutKanban,
  iframe: IconAppWindow,
  youtube: IconBrandYoutube,
  vimeo: IconBrandVimeo,
  loom: IconBrandLoom,
  airtable: IconBrandAirtable,
  typeform: IconForms,
  miro: IconLayoutBoard,
  framer: IconBrandFramer,
  gdrive: IconBrandGoogleDrive,
  gsheets: IconFileSpreadsheet,
  gdocs: IconFileDescription,
  gslides: IconPresentation
};

/**
 * Значок блока по его имени.
 *
 * Приведение здесь одно и с причиной. Отбор блоков (`findBlocks`) отдаёт их
 * общим видом, где имя это просто строка, а таблица объявлена по точному
 * перечню имён — иначе она не проверялась бы на полноту. Строка приходит
 * только из самого перечня, других её источников нет.
 */
export function blockIcon(id: string): ComponentType {
  return BLOCK_ICONS[id as BlockId];
}
