/**
 * Перечень того, что можно вставить в документ.
 *
 * Один перечень на три входа: меню по «/», кнопка «плюс» на панели и вставка
 * с клавиатуры. Разойдясь, они дали бы три разных набора возможностей на одном
 * редакторе — ровно то, чем эта опись и заменяется.
 *
 * Подписи английские и переводятся при показе (`t(block.label)`): английский
 * текст здесь ключ словаря, а не текст интерфейса. Слова для поиска
 * (`keywords`) не переводятся — их сто с лишним, в словаре их нет, и перевод
 * возвращал бы сам ключ. Поиск на другом языке идёт по переведённой подписи.
 *
 * **Значков здесь нет.** Они лежат таблицей в `block-icons.ts`, потому что
 * пакет значков собран только для сборщика: внутри него пути записаны без
 * расширений, и вне Vite он не читается вовсе. Перечень при этом читается
 * проверками. Расхождение двух списков невозможно: таблица объявлена как
 * `Record<BlockId, ...>`, и лишнее либо забытое имя это отказ сборки.
 */

import type { Editor, Range } from '@tiptap/core';
import { fuzzyMatch } from './suggest';
import type { MediaKind } from './upload';

/** Что известно вставке в момент выбора. */
export type BlockContext = {
  editor: Editor;
  /** Страница, к которой привязываются загруженные файлы и встроенные базы. */
  pageId: string;
  /** Отрезок с запросом («/таб»), если вставка пришла из меню по знаку. */
  range?: Range;
  /** Язык для дат и времени. Своё имя месяца на чужом языке в тексте заметно. */
  locale: string;
  /** Показать отказ человеку. Вставка молча ничего не теряет. */
  fail: (error: unknown) => void;
  /** Спросить файл, загрузить его и завести узел. */
  upload: (kind: MediaKind) => void;
  /** Завести базу, привязанную к странице, и встроить её. */
  createBase: (template?: 'kanban') => void;
};

export type Block = {
  /** Опознаётся при проверках и при исключении блока из меню. */
  id: string;
  /** Ключ словаря, он же английская подпись. */
  label: string;
  group: 'basic' | 'media' | 'embed';
  keywords: string;
  /**
   * Блоку нужна страница.
   *
   * Загрузка файла привязывает вложение к странице, встраивание базы заводит
   * её потомком страницы. В шаблоне страницы нет, и предлагать такой блок
   * значило бы обещать вставку, которая отказывает при нажатии.
   */
  needsPage?: true;
  run: (context: BlockContext) => void;
};

/**
 * Блоки, годные там, где страницы нет: в шаблоне и в предпросмотре.
 *
 * Приведение к общему виду нужно из-за `as const` на самой описи: точные имена
 * блоков она сохраняет ценой того, что необязательного поля у записи, где его
 * не написали, для проверки типов не существует вовсе.
 */
export function pagelessBlocks(): Block[] {
  return (BLOCKS as readonly Block[]).filter((one) => !one.needsPage);
}

/**
 * Начать правку: навести каретку и убрать набранный запрос.
 *
 * Удаление отрезка входит в ту же цепочку, что и вставка. Двумя правками
 * подряд оно быть не может: между ними документ уходит соседям, и при отказе
 * второй у всех остаётся страница с исчезнувшим «/таб» и без блока.
 */
function begin(context: BlockContext) {
  const chain = context.editor.chain().focus();
  return context.range ? chain.deleteRange(context.range) : chain;
}

/**
 * Загрузка файла.
 *
 * Сама загрузка приходит с доводом (`context.upload`), а не берётся отсюда:
 * этот перечень не должен знать ни адреса сервера, ни окружения SvelteKit —
 * иначе его нельзя прочитать проверкой, не подняв половину приложения.
 */
function upload(kind: MediaKind) {
  return (context: BlockContext) => {
    begin(context).run();
    context.upload(kind);
  };
}

/** Встраивание внешней службы. Адрес человек вписывает в самом узле. */
function embed<Id extends string>(id: Id, label: string, provider: string) {
  return {
    id,
    label,
    group: 'embed' as const,
    keywords: provider,
    run: (context: BlockContext) => begin(context).setEmbed({ provider }).run()
  };
}

/** Встроить базу в страницу. Заводит её тоже вызывающий, и по той же причине. */
function insertBase(context: BlockContext, template?: 'kanban') {
  begin(context).run();
  context.createBase(template);
}

export const BLOCKS = [
  {
    id: 'text',
    label: 'Text',
    group: 'basic',
    keywords: 'p paragraph plain',
    run: (c) => begin(c).setNode('paragraph').run()
  },
  {
    id: 'heading1',
    label: 'Heading 1',
    group: 'basic',
    keywords: 'title big large h1',
    run: (c) => begin(c).setNode('heading', { level: 1 }).run()
  },
  {
    id: 'heading2',
    label: 'Heading 2',
    group: 'basic',
    keywords: 'subtitle medium h2',
    run: (c) => begin(c).setNode('heading', { level: 2 }).run()
  },
  {
    id: 'heading3',
    label: 'Heading 3',
    group: 'basic',
    keywords: 'subtitle small h3',
    run: (c) => begin(c).setNode('heading', { level: 3 }).run()
  },
  {
    id: 'bulletList',
    label: 'Bullet list',
    group: 'basic',
    keywords: 'unordered point list ul',
    run: (c) => begin(c).toggleBulletList().run()
  },
  {
    id: 'orderedList',
    label: 'Numbered list',
    group: 'basic',
    keywords: 'numbered ordered list ol',
    run: (c) => begin(c).toggleOrderedList().run()
  },
  {
    id: 'taskList',
    label: 'To-do list',
    group: 'basic',
    keywords: 'todo task list check checkbox',
    run: (c) => begin(c).toggleTaskList().run()
  },
  {
    id: 'blockquote',
    label: 'Quote',
    group: 'basic',
    keywords: 'blockquote quotes citation',
    run: (c) => begin(c).toggleBlockquote().run()
  },
  {
    id: 'codeBlock',
    label: 'Code block',
    group: 'basic',
    keywords: 'codeblock snippet pre',
    run: (c) => begin(c).toggleCodeBlock().run()
  },
  {
    id: 'horizontalRule',
    label: 'Divider',
    group: 'basic',
    keywords: 'horizontal rule hr separator line',
    run: (c) => begin(c).setHorizontalRule().run()
  },
  {
    id: 'pageBreak',
    label: 'Page break',
    group: 'basic',
    keywords: 'page break pagebreak print',
    run: (c) => begin(c).setPageBreak().run()
  },
  {
    id: 'table',
    label: 'Table',
    group: 'basic',
    keywords: 'table rows columns grid',
    run: (c) => begin(c).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  },
  {
    id: 'details',
    label: 'Toggle block',
    group: 'basic',
    keywords: 'collapsible block toggle details expand accordion',
    run: (c) => begin(c).setDetails().run()
  },
  {
    id: 'callout',
    label: 'Callout',
    group: 'basic',
    keywords: 'callout notice panel info warning success error danger',
    run: (c) => begin(c).toggleCallout().run()
  },
  {
    id: 'mathInline',
    label: 'Math inline',
    group: 'basic',
    keywords: 'math inline equation katex latex tex formula',
    run: (c) => begin(c).setMathInline().run()
  },
  {
    id: 'mathBlock',
    label: 'Math block',
    group: 'basic',
    keywords: 'math block equation katex latex tex formula',
    run: (c) => begin(c).setMathBlock().run()
  },
  {
    id: 'status',
    label: 'Status',
    group: 'basic',
    keywords: 'status badge label lozenge tag',
    run: (c) => begin(c).setStatus({ text: '', color: 'gray' }).run()
  },
  {
    id: 'subpages',
    label: 'Subpages (Child pages)',
    group: 'basic',
    keywords: 'subpages child children nested hierarchy toc',
    run: (c) => begin(c).insertSubpages().run()
  },
  {
    id: 'transclusion',
    label: 'Synced block',
    group: 'basic',
    keywords: 'sync synced excerpt transclusion reusable snippet',
    run: (c) => begin(c).insertTransclusionSource().run()
  },
  {
    id: 'columns2',
    label: '2 Columns',
    group: 'basic',
    keywords: 'columns layout split side two',
    run: (c) => begin(c).insertColumns({ layout: 'two_equal' }).run()
  },
  {
    id: 'columns3',
    label: '3 Columns',
    group: 'basic',
    keywords: 'columns layout split three triple',
    run: (c) => begin(c).insertColumns({ layout: 'three_equal' }).run()
  },
  {
    id: 'columns4',
    label: '4 Columns',
    group: 'basic',
    keywords: 'columns layout split four',
    run: (c) => begin(c).insertColumns({ layout: 'four_equal' }).run()
  },
  {
    id: 'columns5',
    label: '5 Columns',
    group: 'basic',
    keywords: 'columns layout split five',
    run: (c) => begin(c).insertColumns({ layout: 'five_equal' }).run()
  },
  {
    id: 'date',
    label: 'Date',
    group: 'basic',
    keywords: 'date today calendar',
    run: (c) =>
      begin(c)
        .insertContent(
          new Date().toLocaleDateString(c.locale, {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          })
        )
        .run()
  },
  {
    id: 'time',
    label: 'Time',
    group: 'basic',
    keywords: 'time now clock',
    run: (c) =>
      begin(c)
        .insertContent(
          new Date().toLocaleTimeString(c.locale, { hour: 'numeric', minute: 'numeric' })
        )
        .run()
  },

  {
    id: 'image',
    needsPage: true,
    label: 'Image',
    group: 'media',
    keywords: 'photo picture media file upload',
    run: upload('image')
  },
  {
    id: 'video',
    needsPage: true,
    label: 'Video',
    group: 'media',
    keywords: 'video mp4 movie media file upload',
    run: upload('video')
  },
  {
    id: 'audio',
    needsPage: true,
    label: 'Audio',
    group: 'media',
    keywords: 'audio music sound mp3 media file upload',
    run: upload('audio')
  },
  {
    id: 'pdf',
    needsPage: true,
    label: 'Embed PDF',
    group: 'media',
    keywords: 'pdf document embed file upload',
    run: upload('pdf')
  },
  {
    id: 'attachment',
    needsPage: true,
    label: 'File attachment',
    group: 'media',
    keywords: 'file attachment upload csv zip',
    run: upload('attachment')
  },
  {
    id: 'mermaid',
    label: 'Mermaid diagram',
    group: 'media',
    keywords: 'mermaid diagram chart uml flowchart',
    run: (c) =>
      begin(c)
        .setCodeBlock({ language: 'mermaid' })
        .insertContent('flowchart LR\n    A --> B')
        .run()
  },
  {
    id: 'drawio',
    label: 'Draw.io (diagrams.net)',
    group: 'media',
    keywords: 'drawio diagrams charts uml whiteboard',
    run: (c) => begin(c).setDrawio().run()
  },
  {
    id: 'excalidraw',
    label: 'Excalidraw (Whiteboard)',
    group: 'media',
    keywords: 'excalidraw diagrams draw sketch whiteboard',
    run: (c) => begin(c).setExcalidraw().run()
  },
  {
    id: 'base',
    needsPage: true,
    label: 'Base (Inline)',
    group: 'media',
    keywords: 'base database table grid spreadsheet',
    run: (c) => insertBase(c)
  },
  {
    id: 'kanban',
    needsPage: true,
    label: 'Kanban',
    group: 'media',
    keywords: 'kanban board cards status task database',
    run: (c) => insertBase(c, 'kanban')
  },

  embed('iframe', 'Iframe embed', 'iframe'),
  embed('youtube', 'YouTube', 'youtube'),
  embed('vimeo', 'Vimeo', 'vimeo'),
  embed('loom', 'Loom', 'loom'),
  embed('airtable', 'Airtable', 'airtable'),
  embed('typeform', 'Typeform', 'typeform'),
  embed('miro', 'Miro', 'miro'),
  embed('framer', 'Framer', 'framer'),
  embed('gdrive', 'Google Drive', 'gdrive'),
  embed('gsheets', 'Google Sheets', 'gsheets'),
  embed('gdocs', 'Google Docs', 'gdocs'),
  embed('gslides', 'Google Slides', 'gslides')
] as const satisfies readonly Block[];

/** Имя блока. Перечисление точное: по нему проверяется таблица значков. */
export type BlockId = (typeof BLOCKS)[number]['id'];

/**
 * Отобрать блоки по запросу.
 *
 * Совпадение ищется тремя способами: по нечёткому совпадению подписи (так «hr»
 * находит «Horizontal rule»), по её переводу и по словам для поиска. Ближе к
 * началу оказываются те, у кого запрос входит в подпись целиком: набравший
 * «tab» ищет таблицу, а не «Toggle block», куда те же знаки входят вразбивку.
 */
export function findBlocks(
  query: string,
  translate: (key: string) => string,
  blocks: readonly Block[] = BLOCKS
): Block[] {
  const search = query.toLowerCase().trim();

  const matched = search
    ? blocks.filter(
        (block) =>
          fuzzyMatch(search, block.label) ||
          fuzzyMatch(search, translate(block.label)) ||
          block.keywords.includes(search)
      )
    : [...blocks];

  const exact = (block: Block) =>
    block.label.toLowerCase().includes(search) ||
    translate(block.label).toLowerCase().includes(search)
      ? 0
      : 1;

  return search ? matched.sort((a, b) => exact(a) - exact(b)) : matched;
}
