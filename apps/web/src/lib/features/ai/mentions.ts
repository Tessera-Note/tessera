/**
 * Упоминание страницы в реплике разговора.
 *
 * Поле разговора — обычная многострочная строка, а не редактор: тянуть в неё
 * Tiptap ради одного `@` значило бы тянуть и схему узлов, и её загрузку. Поэтому
 * подсказчик свой и работает по тексту: от последнего `@` до каретки.
 *
 * Смысл в том, что уходит на сервер. Маршрут хода разговора принимает
 * `mentionedPageIds` и кладёт названные страницы в запрос модели целиком —
 * иначе она ищет их поиском и находит не то, что человек имел в виду.
 *
 * Список выбранных сверяется с текстом перед отправкой: удалённое из строки
 * упоминание не должно уходить на сервер, а стёртое наполовину — тем более.
 */

import { searchPages, type SearchHit } from '$lib/features/search/services/search';

/** Страница, названная в реплике. */
export type Mentioned = { id: string; title: string };

/** Задержка перед запросом. Та же, что у выбора страницы и быстрого поиска. */
export const DELAY = 300;

/** Сколько подсказок показывать. Больше не помещается над полем ввода. */
export const LIMIT = 6;

/**
 * Что набрано после `@` перед кареткой.
 *
 * Пусто, когда подсказывать нечего: `@` нет, до него слово вплотную (адрес
 * почты — не упоминание), или после `@` идёт пробел.
 */
export function queryAt(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;

  // Перед `@` должно быть начало строки или пробел: в «кто@example.com» это
  // почта, а не упоминание.
  const previous = at > 0 ? before[at - 1] : ' ';
  if (previous.trim() !== '') return null;

  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return query;
}

/** Заменить набранное `@…` на название страницы. Возвращает строку и место каретки. */
export function insert(
  text: string,
  caret: number,
  title: string
): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return { text, caret };

  const inserted = `@${title} `;
  const made = text.slice(0, at) + inserted + text.slice(caret);
  return { text: made, caret: at + inserted.length };
}

/**
 * Упоминания, которые всё ещё стоят в тексте.
 *
 * Человек правит строку руками: стёртое упоминание не должно уходить на
 * сервер, иначе модель получает страницу, о которой её не спрашивали.
 */
export function present(text: string, chosen: Mentioned[]): Mentioned[] {
  const seen = new Set<string>();
  return chosen.filter((one) => {
    if (seen.has(one.id) || !text.includes(`@${one.title}`)) return false;
    seen.add(one.id);
    return true;
  });
}

/** Подсказки по набранному. Отбор по правам делает сервер. */
export async function suggestions(query: string): Promise<SearchHit[]> {
  const found = await searchPages(query);
  return found.slice(0, LIMIT);
}
