/**
 * Плоский текст документа редактора.
 *
 * Временная мера до фазы редактора: она нужна, чтобы страница показывала
 * содержимое, а не пустой экран, пока представлений узлов нет. Разбор
 * терпимый — узел неизвестного вида отдаёт своих детей, а не пропадает
 * вместе с ними.
 */

type Node = { type?: string; text?: string; content?: Node[] };

/** Узлы, после которых текст переносится на новую строку. */
const BLOCKS = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'taskItem',
  'tableRow'
]);

/** Заголовок документа: уровень и текст. Порядок — порядок в документе. */
export type Heading = { level: number; text: string };

/**
 * Заголовки документа для оглавления.
 *
 * Берутся из самого документа, а не из показанной разметки: разметку собирает
 * редактор, который грузится по требованию, и оглавление до его загрузки было
 * бы пустым. Порядковый номер заголовка здесь и в разметке один и тот же —
 * по нему оглавление и находит, куда переводить взгляд.
 *
 * Заголовок без текста пропускается: пустая строка в оглавлении ведёт в
 * никуда и ни о чём не говорит.
 */
export function headings(content: unknown): Heading[] {
  const found: Heading[] = [];

  const visit = (node: Node | unknown) => {
    if (!node || typeof node !== 'object') return;
    const one = node as Node & { attrs?: { level?: unknown } };

    if (one.type === 'heading') {
      const text = plainText(one).trim();
      const level = Number(one.attrs?.level ?? 1);
      if (text) found.push({ level: Number.isFinite(level) ? level : 1, text });
      return;
    }
    for (const child of one.content ?? []) visit(child);
  };

  visit(content);
  return found;
}

export function plainText(content: unknown): string {
  const lines: string[] = [];
  let current = '';

  const visit = (node: Node | unknown) => {
    if (!node || typeof node !== 'object') return;
    const one = node as Node;

    if (typeof one.text === 'string') current += one.text;
    for (const child of one.content ?? []) visit(child);

    if (one.type && BLOCKS.has(one.type)) {
      lines.push(current.trim());
      current = '';
    }
  };

  visit(content);
  if (current.trim()) lines.push(current.trim());
  return lines.filter(Boolean).join('\n');
}
