/**
 * Proofreading the dictionaries by native speakers — in parts, since the last
 * proofreading.
 *
 * Why. The twelve dictionaries are filled with translations made in the course
 * of the work and have not been proofread by native speakers. There is no reason
 * to hand a proofreader more than a thousand rows every time: after the first
 * proofreading they only need the rows that have appeared or changed since.
 * Crowdin is not turned on for this (`docs/future-roadmap.md`): there are no
 * outside translators, the instance is closed, and nothing but the table file
 * leaves it.
 *
 * How it works. The proofreading mark is `docs/i18n-review-marks.json`: for
 * every language, the commit up to which the dictionary was read by a native
 * speaker, the date and who read it. The export compares the current
 * dictionaries with how they looked in that commit and returns a table of only
 * the rows that:
 *
 * - appeared after the mark;
 * - changed their English source — the translation may have gone stale;
 * - changed their translation — an edit has to be read as well.
 *
 * For a language with no mark everything is exported: the first proofreading is
 * a full one.
 *
 * The order of work:
 *
 *     node scripts/locale-review.mjs status
 *     node scripts/locale-review.mjs export ru-RU            # locale-review-ru-RU.csv
 *     # the proofreader fills in the proposed column where the translation has to change
 *     node scripts/locale-review.mjs import ru-RU locale-review-ru-RU.csv
 *     # the dictionary tests, then commit the changes
 *     node scripts/locale-review.mjs mark ru-RU --reviewer "Name"
 *     # commit the mark
 *
 * The mark is only ever put on a committed dictionary: otherwise it would
 * declare as read something that is not in the history. The import compares the
 * substitutions (`{{name}}`) against the English source and writes nothing on a
 * mismatch.
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

/** The columns of the table. The proofreader fills in only the last one. */
export const COLUMNS = ['key', 'english', 'current', 'reason', 'proposed'];

/** Why a row ended up in the export. */
export const REASON = {
  never: 'never reviewed',
  added: 'new',
  source: 'source changed',
  translation: 'translation changed'
};

/** The substitution names of a string. */
export function placeholders(text) {
  return new Set([...String(text ?? '').matchAll(PLACEHOLDER)].map((one) => one[1]));
}

/**
 * The English source of a key.
 *
 * The number forms (`_few`, `_many`) exist only in Russian and Ukrainian and
 * are absent from the source: for them the `_other` form of the same stem is
 * taken, and failing that the stem itself.
 */
export function englishOf(key, source) {
  if (key in source) return source[key];
  const stem = key.replace(PLURAL, '');
  return source[`${stem}_other`] ?? source[stem];
}

/**
 * The rows to proofread.
 *
 * `baseSource` and `baseTranslated` are the dictionaries as of the mark commit;
 * empty when there is no mark. The order of the rows is the order of the keys of
 * the language dictionary, then the keys of the source that are missing from it:
 * that way the table reads alongside the file.
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
 * Apply what was proofread to the dictionary.
 *
 * The rows with a non-empty `proposed` are taken. A failure on any row — an
 * unknown key or substitutions that diverge from the source — cancels the whole
 * import: a half-applied proofreading is worse than none, as it cannot be told
 * apart from a complete one.
 */
export function applyReview({ source, translated, rows }) {
  const problems = [];
  const changes = {};
  for (const row of rows) {
    const proposed = String(row.proposed ?? '').trim();
    if (!proposed) continue;
    const english = englishOf(row.key, source);
    if (english === undefined) {
      problems.push(`${row.key}: there is no such key in the source`);
      continue;
    }
    const expected = [...placeholders(english)].sort().join(',');
    const actual = [...placeholders(proposed)].sort().join(',');
    // An extra substitution is allowed only for `count`: it is always passed
    // when a key is resolved by number forms. The dictionary rule in the tests
    // is the same.
    const extra = [...placeholders(proposed)].filter((one) => !placeholders(english).has(one) && one !== 'count');
    const lost = [...placeholders(english)].filter((one) => !placeholders(proposed).has(one));
    if (lost.length || extra.length) {
      problems.push(`${row.key}: the substitutions do not match the source (expected ${expected || 'none'}, got ${actual || 'none'})`);
      continue;
    }
    changes[row.key] = proposed;
  }
  if (problems.length) return { updated: null, problems, changed: 0 };

  const updated = {};
  for (const [key, value] of Object.entries(translated)) {
    updated[key] = key in changes ? changes[key] : value;
  }
  // A key that was not in the language dictionary yet goes to the end: the order
  // of the rest of the file is left alone, and the difference reads in the
  // history.
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in updated)) updated[key] = value;
  }
  const changed = Object.keys(changes).filter((key) => translated[key] !== changes[key]).length;
  return { updated, problems, changed };
}

/** The table as CSV. Every field is quoted: translations are full of commas and line breaks. */
export function toCsv(rows) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [COLUMNS.map(quote).join(',')];
  for (const row of rows) lines.push(COLUMNS.map((column) => quote(row[column])).join(','));
  // The byte order mark: without it spreadsheet editors open UTF-8 as garbage,
  // and the proofreader ends up editing text that is already spoiled.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * The delimiter of the table — taken from the header row.
 *
 * Spreadsheet editors of European languages save CSV with a semicolon. Treating
 * both characters as the delimiter at once is not possible: with a comma as the
 * delimiter a semicolon inside a translation is left unquoted, and the row would
 * be split.
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

/** Parse CSV by RFC 4180: quotes, doubled quotes, line breaks inside a field. */
export function parseCsv(text) {
  const body = String(text).replace(/^﻿/, '');
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
    if (!(column in index)) throw new Error(`the table has no ${column} column`);
  }
  return rest.map((values) => Object.fromEntries(COLUMNS.map((column) => [column, values[index[column]] ?? ''])));
}

// --- the command line wrapper ---------------------------------------------

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
      const state = mark ? `up to ${mark.commit.slice(0, 8)}, ${mark.date}, ${mark.reviewer}` : 'not proofread';
      console.log(`${one}: ${state}; rows to proofread: ${pendingFor(one).length}`);
    }
    return 0;
  }

  if (!locale || !known.includes(locale) || locale === SOURCE) {
    console.error(`a language is required, one of: ${known.filter((name) => name !== SOURCE).join(', ')}`);
    return 1;
  }

  if (command === 'export') {
    const rows = pendingFor(locale);
    const out = option(rest, '--out') ?? `locale-review-${locale}.csv`;
    writeFileSync(out, toCsv(rows));
    console.log(`${out}: rows to proofread ${rows.length}`);
    return 0;
  }

  if (command === 'import') {
    const file = rest[0];
    if (!file) {
      console.error('the table file is required');
      return 1;
    }
    const { updated, problems, changed } = applyReview({
      source: dictionary(SOURCE),
      translated: dictionary(locale),
      rows: parseCsv(readFileSync(file, 'utf8'))
    });
    if (problems.length) {
      console.error('nothing was applied:');
      for (const one of problems) console.error(`  ${one}`);
      return 1;
    }
    writeFileSync(join(ROOT, LOCALES, `${locale}.json`), `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`${locale}: rows changed ${changed}. Run the dictionary tests and commit.`);
    return 0;
  }

  if (command === 'mark') {
    const reviewer = option(rest, '--reviewer');
    if (!reviewer) {
      console.error('--reviewer "Name" is required');
      return 1;
    }
    const files = [`${LOCALES}/${locale}.json`, `${LOCALES}/${SOURCE}.json`];
    if (git('status', '--porcelain', '--', ...files).trim()) {
      console.error('the dictionary is not committed: the mark would declare as read something that is not in the history');
      return 1;
    }
    const commit = option(rest, '--commit') ?? git('rev-parse', 'HEAD').trim();
    const marks = readMarks();
    marks[locale] = { commit, date: new Date().toISOString().slice(0, 10), reviewer };
    const ordered = Object.fromEntries(Object.keys(marks).sort().map((key) => [key, marks[key]]));
    writeFileSync(join(ROOT, MARKS), `${JSON.stringify(ordered, null, 2)}\n`);
    console.log(`${locale}: proofread up to ${commit.slice(0, 8)}. Commit ${MARKS}.`);
    return 0;
  }

  console.error('the commands: status, export <language>, import <language> <file>, mark <language> --reviewer "Name"');
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
