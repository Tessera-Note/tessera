/**
 * Каждый код отказа сервера имеет подпись в словаре.
 *
 * Отдельным файлом от правил словарей: там речь о самих словарях, а здесь о
 * договоре между сервером и клиентом. Сервер отвечает кодом
 * (`{code, message, params}`), клиент переводит его по словарю, и код без
 * подписи показывается человеку как есть — `error.space.slug_taken` на экране.
 *
 * Проверка читает исходники сервера, и это тот редкий случай, когда иначе
 * нельзя: коды поднимаются строковыми литералами, исполнимого их перечня не
 * существует. Тот же способ уже применён к ключам интерфейса в
 * `dictionaries.test.ts`.
 *
 * Английский текст сверяется с сервером там, где он у сервера есть: человек с
 * английским интерфейсом не должен видеть одну фразу от словаря и другую от
 * сервера при одном и том же отказе.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', '..', '..', 'static', 'locales');
const API = join(HERE, '..', '..', '..', '..', 'api', 'tessera_api');

/** Код отказа: `error.` и дальше разделы через точку. */
const CODE = /["'](error\.[a-z0-9_]+(?:\.[a-z0-9_]+)+)["']/g;

/** Таблица английских текстов сервера. Разбирается как есть, без запуска. */
const SERVER_MESSAGES = join(API, 'domain', 'errors.py');

function pythonFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...pythonFiles(full));
    else if (entry.name.endsWith('.py')) found.push(full);
  }
  return found;
}

/** Все коды, какие поднимает сервер. */
function serverCodes(): Set<string> {
  const found = new Set<string>();
  for (const file of pythonFiles(API)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(CODE)) found.add(match[1]);
  }
  return found;
}

/**
 * Английские тексты из `ERROR_MESSAGES`.
 *
 * Разбирается кусок исходника между открывающей и закрывающей скобкой таблицы:
 * значения там простые строки в одну или несколько склеенных частей.
 */
function serverMessages(): Map<string, string> {
  const text = readFileSync(SERVER_MESSAGES, 'utf8');
  const start = text.indexOf('ERROR_MESSAGES: dict[str, str] = {');
  const end = text.indexOf('\n}', start);
  const body = text.slice(start, end);

  const made = new Map<string, string>();
  const entry = /"(error\.[a-z0-9_.]+)":\s*((?:\s*"(?:[^"\\]|\\.)*")+)/g;
  for (const match of body.matchAll(entry)) {
    const pieces = match[2].match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    made.set(match[1], pieces.map((one) => JSON.parse(one) as string).join(''));
  }
  return made;
}

const dictionary = JSON.parse(readFileSync(join(LOCALES, 'en-US.json'), 'utf8')) as Record<
  string,
  string
>;
const codes = serverCodes();
const messages = serverMessages();

describe('коды отказов', () => {
  it('проверка что-то находит', () => {
    // Опора остальных: пустое множество кодов дало бы зелёный результат на
    // пустоте, то есть подтверждало бы, что все коды подписаны, потому что
    // подписывать нечего.
    expect(codes.size).toBeGreaterThan(150);
    expect(codes.has('error.page.page_not_found')).toBe(true);
    expect(messages.size).toBeGreaterThan(50);
  });

  it('у каждого кода есть подпись в источнике', () => {
    // Код без подписи человек видит как есть: `error.space.slug_taken` на
    // экране вместо фразы.
    const missing = [...codes].filter((one) => !(one in dictionary)).sort();
    expect(missing).toEqual([]);
  });

  it.each(['ru-RU', 'uk-UA'])('%s подписывает те же коды', (locale) => {
    const translated = JSON.parse(readFileSync(join(LOCALES, `${locale}.json`), 'utf8')) as Record<
      string,
      string
    >;
    const missing = [...codes].filter((one) => !(one in translated)).sort();
    expect(missing).toEqual([]);
  });

  it('английская подпись совпадает с текстом сервера', () => {
    // Расхождение означало бы две разные фразы на один отказ: одну от словаря,
    // другую от самого сервера, когда кода в словаре не нашлось.
    const differing = [...messages.entries()]
      .filter(([code, text]) => code in dictionary && dictionary[code] !== text)
      .map(([code]) => code)
      .sort();
    expect(differing).toEqual([]);
  });

  it('подписи не остались непереведёнными', () => {
    // Русская подпись, совпадающая с английской, означает, что перевод забыли:
    // человек видит английскую фразу в русском интерфейсе.
    const russian = JSON.parse(readFileSync(join(LOCALES, 'ru-RU.json'), 'utf8')) as Record<
      string,
      string
    >;
    const untranslated = [...codes]
      .filter((one) => one in russian && russian[one] === dictionary[one])
      // Латиница в русской подписи законна там, где фраза и есть имя: таких
      // кодов нет, но правило стоит записать явно.
      .filter((one) => /[а-яё]/i.test(dictionary[one] ?? '') === false)
      .filter((one) => dictionary[one] !== undefined)
      .sort();
    expect(untranslated).toEqual([]);
  });
});
