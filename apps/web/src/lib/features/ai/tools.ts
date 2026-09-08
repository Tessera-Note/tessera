/**
 * Шаги агента человеческими словами.
 *
 * Ход агента состоит из вызовов инструментов, и без названий транскрипт
 * показывает `search_workspace` вместо «Искал по страницам». В v1 то же самое
 * (`ee/ai-chat/components/chat-tool-result.tsx`), но там названия зашиты
 * по-английски; здесь они проходят через словарь, как любой видимый текст.
 *
 * Перечислены не все инструменты: их полсотни, и большая часть в разговоре не
 * встречается. Незнакомое имя показывается как есть — это лучше, чем не
 * показать шаг вовсе.
 */

/** Вызов инструмента так, как его сохраняет сервер. */
export type ToolCall = {
  id?: string | null;
  name?: string | null;
  args?: unknown;
  result?: unknown;
};

/**
 * Ключи словаря для имён инструментов.
 *
 * Наружу, чтобы проверка словарей видела их: ключ здесь стоит значением описи,
 * а не доводом вызова перевода, и разбор по вызовам такие строки пропускает.
 */
export const TOOL_LABELS: Record<string, string> = {
  list_spaces: 'Listed spaces',
  list_pages: 'Listed pages',
  get_page: 'Read page',
  search_workspace: 'Searched pages',
  search_semantic: 'Searched by meaning',
  search_web: 'Searched the web',
  create_page: 'Created page',
  update_page: 'Updated page'
};

/** Название шага. Перевод берётся вызывающим: словарь живёт в хранилище языка. */
export function toolLabel(name: string | null | undefined, t: (key: string) => string): string {
  if (!name) return '';
  const known = TOOL_LABELS[name];
  return known ? t(known) : name;
}

/**
 * Вызовы из сохранённой реплики.
 *
 * Поле приходит из базы как есть, поэтому проверяется здесь: разговор старше
 * текущей записи мог сохранить что угодно, и обращение к `name` у строки
 * уронило бы весь транскрипт.
 */
export function toolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((one): one is ToolCall => typeof one === 'object' && one !== null);
}
