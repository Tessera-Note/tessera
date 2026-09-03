/**
 * Разбор тела комментария для показа.
 *
 * Читающему обсуждение редактор не нужен: на странице их бывает полсотни, и
 * полсотни редакторов ради показа трёх строк это полсотни наборов расширений
 * в памяти. Показ разбирает документ сам, а правит его настоящий редактор —
 * узлы у них одни и те же.
 *
 * Без единого импорта намеренно: разбор проверяется сам по себе.
 */

/** Узел документа так, как он приходит от сервера. */
type Raw = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: Raw[];
};

/** Кусок строки: текст со своими начертаниями либо упоминание. */
export type Piece =
  | {
      kind: 'text';
      text: string;
      bold: boolean;
      italic: boolean;
      strike: boolean;
      code: boolean;
      href: string | null;
    }
  | { kind: 'mention'; label: string; slugId: string | null; page: boolean };

/** Строка показа: вид блока и его куски. */
export type Line = { block: 'paragraph' | 'quote' | 'code' | 'item'; pieces: Piece[] };

/** Виды блоков, каждый со своим показом. Прочее показывается абзацем. */
const BLOCKS: Record<string, Line['block']> = {
  paragraph: 'paragraph',
  heading: 'paragraph',
  codeBlock: 'code'
};

/**
 * Обрамляющие узлы: свой вид они задают всему, что внутри.
 *
 * Внутри цитаты и пункта перечня лежит абзац, и без этого правила он объявлял
 * бы себя обычным абзацем — цитата теряла бы полосу, а пункт отступ.
 */
const CONTAINERS: Record<string, Line['block']> = {
  blockquote: 'quote',
  listItem: 'item',
  taskItem: 'item'
};

/**
 * Разобрать документ в строки.
 *
 * Узел неизвестного вида отдаёт своих детей, а не пропадает вместе с ними:
 * потерять текст комментария из-за узла, о котором показ не знает, хуже, чем
 * показать его без обрамления.
 */
export function readRichText(content: unknown): Line[] {
  const lines: Line[] = [];

  const walk = (node: Raw, block: Line['block'] | null) => {
    if (typeof node.text === 'string') {
      push(lines, block ?? 'paragraph', textPiece(node));
      return;
    }
    if (node.type === 'mention') {
      push(lines, block ?? 'paragraph', mentionPiece(node));
      return;
    }
    if (node.type === 'hardBreak') {
      lines.push({ block: block ?? 'paragraph', pieces: [] });
      return;
    }

    const container = node.type ? CONTAINERS[node.type] : undefined;
    if (container) {
      for (const child of node.content ?? []) walk(child, container);
      return;
    }

    const own = node.type ? BLOCKS[node.type] : undefined;
    if (own) {
      // Внутри обрамления вид остаётся его: абзац в цитате — часть цитаты.
      const use = block === 'quote' || block === 'item' ? block : own;
      lines.push({ block: use, pieces: [] });
      for (const child of node.content ?? []) walk(child, use);
      return;
    }

    for (const child of node.content ?? []) walk(child, block);
  };

  if (content && typeof content === 'object') walk(content as Raw, null);
  return lines.filter((line) => line.pieces.length > 0);
}

function push(lines: Line[], block: Line['block'], piece: Piece) {
  const last = lines[lines.length - 1];
  if (last && last.block === block) last.pieces.push(piece);
  else lines.push({ block, pieces: [piece] });
}

function textPiece(node: Raw): Piece {
  const marks = new Set((node.marks ?? []).map((mark) => mark.type));
  const link = (node.marks ?? []).find((mark) => mark.type === 'link');
  const href = link?.attrs?.href;
  return {
    kind: 'text',
    text: node.text ?? '',
    bold: marks.has('bold'),
    italic: marks.has('italic'),
    strike: marks.has('strike'),
    code: marks.has('code'),
    href: typeof href === 'string' ? href : null
  };
}

function mentionPiece(node: Raw): Piece {
  const attrs = node.attrs ?? {};
  const slug = attrs.slugId;
  return {
    kind: 'mention',
    label: String(attrs.label ?? attrs.entityId ?? ''),
    slugId: typeof slug === 'string' ? slug : null,
    page: attrs.entityType === 'page'
  };
}

/** Пусто ли тело: по нему решается, есть ли что показывать. */
export function isEmptyRichText(content: unknown): boolean {
  return readRichText(content).length === 0;
}
