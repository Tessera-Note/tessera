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
