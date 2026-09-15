/**
 * Вычитка словарей носителями языка — по частям, с прошлой вычитки.
 *
 * Зачем. Двенадцать словарей заведены переводами, сделанными в работе, и
 * носителями не вычитаны. Отдавать вычитывающему две с лишним тысячи строк
 * каждый раз незачем: после первой вычитки ему нужны только строки, которые с
 * тех пор появились или поменялись. Crowdin для этого не включается
 * (`docs/future-roadmap.md`): переводчиков со стороны нет, экземпляр закрытый,
 * и ничего, кроме файла таблицы, наружу не уходит.
 *
 * Как устроено. Отметка вычитки — `docs/i18n-review-marks.json`: для каждого
 * языка коммит, до которого словарь прочитан носителем, дата и кто читал.
 * Выгрузка сравнивает нынешние словари с их видом в этом коммите и отдаёт
 * таблицу только из строк, которые:
 *
 * - появились после отметки;
 * - сменили английский источник — перевод мог устареть;
 * - сменили перевод — правку тоже надо прочитать.
 *
 * У языка без отметки выгружается всё: первая вычитка — полная.
 *
 * Порядок работы:
 *
 *     node scripts/locale-review.mjs status
 *     node scripts/locale-review.mjs export ru-RU            # locale-review-ru-RU.csv
 *     # вычитывающий заполняет столбец proposed там, где перевод надо поменять
 *     node scripts/locale-review.mjs import ru-RU locale-review-ru-RU.csv
 *     # проверки словарей, коммит правок
 *     node scripts/locale-review.mjs mark ru-RU --reviewer "Имя"
 *     # коммит отметки
 *
 * Отметка ставится только на закоммиченный словарь: иначе она объявляла бы
 * прочитанным то, чего в истории нет. Внесение сверяет подстановки
 * (`{{name}}`) с английским источником и при расхождении ничего не пишет.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = 'apps/web/static/locales';
const MARKS = 'docs/i18n-review-marks.json';
const SOURCE = 'en-US';
const PLURAL = /_(zero|one|two|few|many|other)$/;
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/** Столбцы таблицы. Вычитывающий заполняет только последний. */
export const COLUMNS = ['key', 'english', 'current', 'reason', 'proposed'];

/** Почему строка попала в выгрузку. */
export const REASON = {
  never: 'never reviewed',
  added: 'new',
  source: 'source changed',
  translation: 'translation changed'
};

/** Имена подстановок строки. */
export function placeholders(text) {
  return new Set([...String(text ?? '').matchAll(PLACEHOLDER)].map((one) => one[1]));
}

/**
 * Английский источник ключа.
 *
 * Формы числа (`_few`, `_many`) бывают только у русского и украинского, в
 * источнике их нет: для них берётся форма `_other` той же основы, а без неё —
 * сама основа.
 */
export function englishOf(key, source) {
  if (key in source) return source[key];
  const stem = key.replace(PLURAL, '');
  return source[`${stem}_other`] ?? source[stem];
}

/**
 * Строки к вычитке.
 *
 * `baseSource` и `baseTranslated` — словари в коммите отметки; пустые, если
 * отметки нет. Порядок строк — порядок ключей словаря языка, затем ключи
 * источника, которых в нём нет: так таблица читается рядом с файлом.
 */
export function pendingRows({ source, translated, baseSource = null, baseTranslated = null }) {
  const keys = [...Object.keys(translated), ...Object.keys(source).filter((key) => !(key in translated))];
  const rows = [];
  for (const key of keys) {
    const english = englishOf(key, source);
    if (english === undefined) continue;
    let reason = null;
    if (!baseSource || !baseTranslated) {
      reason = REASON.never;
    } else if (!(key in baseTranslated) && !(key in baseSource)) {
      reason = REASON.added;
    } else if (englishOf(key, baseSource) !== english) {
      reason = REASON.source;
    } else if (baseTranslated[key] !== translated[key]) {
      reason = REASON.translation;
    }
    if (reason) rows.push({ key, english, current: translated[key] ?? '', reason, proposed: '' });
  }
  return rows;
}

/**
 * Внести вычитанное в словарь.
 *
 * Берутся строки с непустым `proposed`. Отказ по любой строке — неизвестный
 * ключ или расхождение подстановок с источником — отменяет внесение целиком:
 * наполовину внесённая вычитка хуже невнесённой, её не отличить от полной.
 */
export function applyReview({ source, translated, rows }) {
  const problems = [];
  const changes = {};
  for (const row of rows) {
    const proposed = String(row.proposed ?? '').trim();
    if (!proposed) continue;
    const english = englishOf(row.key, source);
    if (english === undefined) {
      problems.push(`${row.key}: такого ключа в источнике нет`);
      continue;
    }
    const expected = [...placeholders(english)].sort().join(',');
    const actual = [...placeholders(proposed)].sort().join(',');
    // Лишней подстановка допустима только `count`: он передаётся всегда, когда
    // ключ разбирается по формам числа. Так же правило словарей в проверках.
    const extra = [...placeholders(proposed)].filter((one) => !placeholders(english).has(one) && one !== 'count');
    const lost = [...placeholders(english)].filter((one) => !placeholders(proposed).has(one));
    if (lost.length || extra.length) {
      problems.push(`${row.key}: подстановки не совпадают с источником (ждём ${expected || 'никаких'}, пришло ${actual || 'никаких'})`);
      continue;
    }
    changes[row.key] = proposed;
  }
  if (problems.length) return { updated: null, problems, changed: 0 };

  const updated = {};
  for (const [key, value] of Object.entries(translated)) {
    updated[key] = key in changes ? changes[key] : value;
  }
  // Ключ, которого в словаре языка ещё не было, встаёт в конец: порядок
  // остального файла не трогается, и разница в истории читается.
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in updated)) updated[key] = value;
  }
  const changed = Object.keys(changes).filter((key) => translated[key] !== changes[key]).length;
  return { updated, problems, changed };
}

/** Таблица в CSV. Каждое поле в кавычках: переводы полны запятых и переносов. */
export function toCsv(rows) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [COLUMNS.map(quote).join(',')];
  for (const row of rows) lines.push(COLUMNS.map((column) => quote(row[column])).join(','));
  // Метка порядка байтов: без неё табличные редакторы открывают UTF-8
  // кракозябрами, и вычитывающий правит уже испорченный текст.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Разделитель таблицы — по строке заголовка.
 *
 * Табличные редакторы европейских языков сохраняют CSV с точкой с запятой.
 * Считать разделителем оба знака сразу нельзя: при запятой-разделителе точка
 * с запятой внутри перевода остаётся без кавычек, и строка разбилась бы.
 */
export function delimiterOf(body) {
  let quoted = false;
  let commas = 0;
  let semicolons = 0;
  for (const char of body) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char === ',') commas += 1;
    else if (!quoted && char === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

/** Разобрать CSV по RFC 4180: кавычки, удвоенные кавычки, переносы внутри поля. */
export function parseCsv(text) {
  const body = String(text).replace(/^\uFEFF/, '');
  const delimiter = delimiterOf(body);
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[index + 1] === '\n') index += 1;
      record.push(field);
      if (record.some((one) => one !== '')) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || record.length) {
    record.push(field);
    if (record.some((one) => one !== '')) records.push(record);
  }
  if (!records.length) return [];
  const [header, ...rest] = records;
  const index = Object.fromEntries(header.map((name, position) => [name.trim(), position]));
  for (const column of ['key', 'proposed']) {
    if (!(column in index)) throw new Error(`в таблице нет столбца ${column}`);
  }
  return rest.map((values) => Object.fromEntries(COLUMNS.map((column) => [column, values[index[column]] ?? ''])));
}

// --- обвязка командной строки ---------------------------------------------

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function dictionaryAt(commit, locale) {
  return JSON.parse(git('show', `${commit}:${LOCALES}/${locale}.json`));
}

function dictionary(locale) {
  return JSON.parse(readFileSync(join(ROOT, LOCALES, `${locale}.json`), 'utf8'));
}

function readMarks() {
  try {
    return JSON.parse(readFileSync(join(ROOT, MARKS), 'utf8'));
  } catch {
    return {};
  }
}

function pendingFor(locale) {
  const mark = readMarks()[locale];
  return pendingRows({
    source: dictionary(SOURCE),
    translated: dictionary(locale),
    baseSource: mark ? dictionaryAt(mark.commit, SOURCE) : null,
    baseTranslated: mark ? dictionaryAt(mark.commit, locale) : null
  });
}

function option(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
}

function main(argv) {
  const [command, locale, ...rest] = argv;
  const known = readdirLocales();

  if (command === 'status') {
    const marks = readMarks();
    for (const one of known.filter((name) => name !== SOURCE)) {
      const mark = marks[one];
      const state = mark ? `до ${mark.commit.slice(0, 8)}, ${mark.date}, ${mark.reviewer}` : 'не вычитан';
      console.log(`${one}: ${state}; к вычитке строк: ${pendingFor(one).length}`);
    }
    return 0;
  }

  if (!locale || !known.includes(locale) || locale === SOURCE) {
    console.error(`нужен язык из: ${known.filter((name) => name !== SOURCE).join(', ')}`);
    return 1;
  }

  if (command === 'export') {
    const rows = pendingFor(locale);
    const out = option(rest, '--out') ?? `locale-review-${locale}.csv`;
    writeFileSync(out, toCsv(rows));
    console.log(`${out}: строк к вычитке ${rows.length}`);
    return 0;
  }

  if (command === 'import') {
    const file = rest[0];
    if (!file) {
      console.error('нужен файл таблицы');
      return 1;
    }
    const { updated, problems, changed } = applyReview({
      source: dictionary(SOURCE),
      translated: dictionary(locale),
      rows: parseCsv(readFileSync(file, 'utf8'))
    });
    if (problems.length) {
      console.error('ничего не внесено:');
      for (const one of problems) console.error(`  ${one}`);
      return 1;
    }
    writeFileSync(join(ROOT, LOCALES, `${locale}.json`), `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`${locale}: изменено строк ${changed}. Прогнать проверки словарей и закоммитить.`);
    return 0;
  }

  if (command === 'mark') {
    const reviewer = option(rest, '--reviewer');
    if (!reviewer) {
      console.error('нужен --reviewer "Имя"');
      return 1;
    }
    const files = [`${LOCALES}/${locale}.json`, `${LOCALES}/${SOURCE}.json`];
    if (git('status', '--porcelain', '--', ...files).trim()) {
      console.error('словарь не закоммичен: отметка объявила бы прочитанным то, чего в истории нет');
      return 1;
    }
    const commit = option(rest, '--commit') ?? git('rev-parse', 'HEAD').trim();
    const marks = readMarks();
    marks[locale] = { commit, date: new Date().toISOString().slice(0, 10), reviewer };
    const ordered = Object.fromEntries(Object.keys(marks).sort().map((key) => [key, marks[key]]));
    writeFileSync(join(ROOT, MARKS), `${JSON.stringify(ordered, null, 2)}\n`);
    console.log(`${locale}: вычитан до ${commit.slice(0, 8)}. Закоммитить ${MARKS}.`);
    return 0;
  }

  console.error('команды: status, export <язык>, import <язык> <файл>, mark <язык> --reviewer "Имя"');
  return 1;
}

function readdirLocales() {
  return git('ls-files', LOCALES)
    .split('\n')
    .filter((one) => one.endsWith('.json'))
    .map((one) => one.split('/').pop().replace('.json', ''))
    .sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
