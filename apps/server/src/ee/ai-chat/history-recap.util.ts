/**
 * Что агент сделал на прошлых ходах, в виде, пригодном для следующего хода.
 *
 * У агента нет настоящего вызова инструментов, поэтому все сделанное живет в
 * колонке `tool_calls` сообщения: созданные и измененные страницы, найденное
 * в вики, найденное в интернете. В историю для модели уходило только поле
 * `content`, то есть собственная проза агента, и на следующем ходе он не знал
 * ни адреса страницы, которую сам же создал минуту назад, ни того, что нашел.
 *
 * Замечено на живом сценарии: агент создал страницу, а на просьбу «расширь
 * страницу» ответил, что ее адрес ему не передан, и попросил прислать ссылку
 * на только что созданную им же страницу.
 *
 * Пересказ приписывается к содержимому сообщения ассистента при сборке
 * истории. Хранимое не меняется: `tool_calls` уже содержат все нужное.
 */

/** Сколько страниц и источников попадает в пересказ одного хода. */
const MAX_ITEMS = 8;

/** Предел длины заголовка и названия источника. */
const MAX_TITLE = 120;

type ToolCall = {
  name?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

function trim(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE)}…` : text;
}

/** Правки записывают идентификатор как `pageId`, выдача поиска как `id`. */
function describePage(args: Record<string, unknown> | undefined): string {
  const id = trim(args?.pageId ?? args?.id);
  const title = trim(args?.title);
  if (title && id) return `«${title}» (id ${id})`;
  return id ? `id ${id}` : title ? `«${title}»` : '';
}

export function buildHistoryRecap(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';

  const created: string[] = [];
  const edited: string[] = [];
  const foundPages: string[] = [];
  const foundWeb: string[] = [];

  for (const raw of toolCalls as ToolCall[]) {
    if (!raw || typeof raw !== 'object') continue;

    const applied = (raw.result as any)?.status === 'applied';

    switch (raw.name) {
      case 'create_page': {
        // Отказавшая правка в пересказ не попадает: ссылаться не на что.
        if (applied) created.push(describePage(raw.args));
        break;
      }
      case 'update_page':
      case 'update_page_title': {
        if (applied) edited.push(describePage(raw.args));
        break;
      }
      case 'search_pages': {
        const pages = ((raw.result as any)?.pages ?? []) as Array<{
          id?: string;
          title?: string;
        }>;
        for (const page of pages.slice(0, MAX_ITEMS)) {
          const described = describePage(page as Record<string, unknown>);
          if (described) foundPages.push(described);
        }
        break;
      }
      case 'search_web': {
        const results = ((raw.result as any)?.results ?? []) as Array<{
          title?: string;
          url?: string;
        }>;
        for (const item of results.slice(0, MAX_ITEMS)) {
          const title = trim(item?.title);
          const url = trim(item?.url);
          if (url) foundWeb.push(title ? `${title} — ${url}` : url);
        }
        break;
      }
      default:
        break;
    }
  }

  const lines: string[] = [];

  if (created.length > 0) {
    lines.push(`created pages: ${created.filter(Boolean).join('; ')}`);
  }
  if (edited.length > 0) {
    lines.push(`edited pages: ${edited.filter(Boolean).join('; ')}`);
  }
  if (foundPages.length > 0) {
    lines.push(`wiki pages found: ${foundPages.join('; ')}`);
  }
  if (foundWeb.length > 0) {
    lines.push(`web results: ${foundWeb.join('; ')}`);
  }

  if (lines.length === 0) return '';

  return (
    '\n\n[what you did on this turn, for your own reference; ' +
    'use these ids when the user refers back to it]\n' +
    lines.join('\n')
  );
}
