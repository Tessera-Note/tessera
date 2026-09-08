/**
 * Подбор эмодзи по «:».
 *
 * Набор лежит отдельным файлом (`emoji-data.ts`, сто тридцать килобайт) и
 * читается по требованию: в редакторе он нужен тому, кто набрал двоеточие, а
 * платить за него загрузкой страницы должны были бы все.
 *
 * Часто выбранные помнятся в этом браузере. Список подбора короткий, и без
 * такой памяти человек, ставящий одну и ту же отметку по десять раз в день,
 * каждый раз ищет её заново.
 */

import type { EmojiRow } from './emoji-data';

/** Сколько показывать. Список выбора, а не перечень набора. */
const LIMIT = 8;

const STORAGE_KEY = 'tessera.emoji.frequent';
/** Сколько имён помнить. Больше — и память перестаёт быть подсказкой. */
const REMEMBER = 24;

let loaded: readonly EmojiRow[] | null = null;

/** Прочитать набор. Второй вызов отдаёт уже прочитанное. */
export async function emojiSet(): Promise<readonly EmojiRow[]> {
  if (!loaded) {
    loaded = (await import('./emoji-data')).EMOJI;
  }
  return loaded;
}

function readFrequent(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const counts: Record<string, number> = {};
    for (const [id, times] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof times === 'number' && Number.isFinite(times)) counts[id] = times;
    }
    return counts;
  } catch {
    // Хранилище закрыто настройками браузера или содержит не наше. Подсказка
    // необязательна — подбор работает и без неё.
    return {};
  }
}

/** Запомнить выбор. Отказ хранилища не мешает вставке. */
export function rememberEmoji(id: string): void {
  if (typeof localStorage === 'undefined') return;
  const counts = readFrequent();
  counts[id] = (counts[id] ?? 0) + 1;

  const kept = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, REMEMBER);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Хранилище переполнено или закрыто. Терять из-за этого вставку незачем.
  }
}

/**
 * Отобрать эмодзи по запросу.
 *
 * Порядок: сначала те, чьё имя начинается с запроса, потом остальные
 * совпадения. Внутри каждой части — по числу прошлых выборов. Набравший
 * «:smi» ждёт «smile» первой строкой, а не «beaming face with smiling eyes».
 */
export function findEmoji(
  query: string,
  set: readonly EmojiRow[],
  frequent: Record<string, number> = readFrequent()
): EmojiRow[] {
  const search = query.toLowerCase().trim();
  if (!search) {
    return set
      .filter((row) => frequent[row[1]])
      .sort((a, b) => (frequent[b[1]] ?? 0) - (frequent[a[1]] ?? 0))
      .slice(0, LIMIT);
  }

  const found = set.filter((row) => row[2].includes(search));
  found.sort((a, b) => {
    const rank = starts(a, search) - starts(b, search);
    if (rank !== 0) return rank;
    return (frequent[b[1]] ?? 0) - (frequent[a[1]] ?? 0);
  });
  return found.slice(0, LIMIT);
}

function starts(row: EmojiRow, search: string): number {
  return row[1].startsWith(search) ? 0 : 1;
}
