/**
 * Tests for the partial proofreading of the dictionaries.
 *
 * What is tested are the rules the proofreader depends on to read what they
 * need and break nothing: only what changed since the last proofreading gets
 * into the export, the table survives the "export — edit in a spreadsheet —
 * import" round trip, and an import with a wrong substitution writes nothing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { REASON, applyReview, parseCsv, pendingRows, placeholders, toCsv } from './locale-review.mjs';

const baseSource = { Save: 'Save', Hello: 'Hello, {{name}}', Old: 'Old text' };
const baseTranslated = { Save: 'Сохранить', Hello: 'Привет, {{name}}', Old: 'Старый текст' };

test('with no mark everything is exported', () => {
  const rows = pendingRows({ source: baseSource, translated: baseTranslated });
  assert.deepEqual(
    rows.map((one) => one.reason),
    [REASON.never, REASON.never, REASON.never]
  );
});

test('with a mark, only what changed after it', () => {
  const source = { ...baseSource, Old: 'Reworded text', Fresh: 'Fresh' };
  const translated = { ...baseTranslated, Save: 'Сохранить изменения', Fresh: 'Свежее' };
  const rows = pendingRows({ source, translated, baseSource, baseTranslated });
  const byKey = Object.fromEntries(rows.map((one) => [one.key, one.reason]));
  assert.deepEqual(byKey, {
    Save: REASON.translation,
    Old: REASON.source,
    Fresh: REASON.added
  });
  // An untouched row does not get into the export: that is what the export is
  // partial for.
  assert.equal('Hello' in byKey, false);
});

test('a source key with no translation is up for proofreading too', () => {
  const source = { ...baseSource, Missing: 'Missing' };
  const rows = pendingRows({ source, translated: baseTranslated, baseSource, baseTranslated });
  assert.deepEqual(
    rows.map((one) => [one.key, one.current, one.reason]),
    [['Missing', '', REASON.added]]
  );
});

test('number forms are compared against the other form of the source', () => {
  const source = { 'Files_one': '{{count}} file', 'Files_other': '{{count}} files' };
  const translated = {
    Files_one: '{{count}} файл',
    Files_few: '{{count}} файла',
    Files_many: '{{count}} файлов',
    Files_other: '{{count}} файла'
  };
  const rows = pendingRows({ source, translated });
  const few = rows.find((one) => one.key === 'Files_few');
  assert.equal(few.english, '{{count}} files');
});

test('the table survives a round trip through CSV', () => {
  const rows = [
    { key: 'Hello', english: 'Hello, "friend"', current: 'Привет,\nдруг', reason: REASON.never, proposed: '' }
  ];
  const back = parseCsv(toCsv(rows));
  assert.deepEqual(back, rows);
});

test('parsing accepts a semicolon and a byte order mark', () => {
  const text = '﻿key;english;current;reason;proposed\r\n"Save";"Save";"Сохранить";"new";"Записать"\r\n';
  assert.deepEqual(parseCsv(text), [
    { key: 'Save', english: 'Save', current: 'Сохранить', reason: 'new', proposed: 'Записать' }
  ]);
});

test('with a comma as the delimiter a semicolon stays text', () => {
  const text = 'key,english,current,reason,proposed\n"Save","Save",Сохранить; записать,new,\n';
  assert.equal(parseCsv(text)[0].current, 'Сохранить; записать');
});

test('a table with no proposed column is not accepted', () => {
  assert.throws(() => parseCsv('key,english\n"Save","Save"\n'), /proposed/);
});

test('the import changes only the filled-in rows', () => {
  const rows = [
    { key: 'Save', proposed: 'Записать' },
    { key: 'Old', proposed: '   ' }
  ];
  const { updated, problems, changed } = applyReview({
    source: baseSource,
    translated: baseTranslated,
    rows
  });
  assert.deepEqual(problems, []);
  assert.equal(changed, 1);
  assert.equal(updated.Save, 'Записать');
  assert.equal(updated.Old, 'Старый текст');
  // The order of the keys of the file does not change: the difference reads in
  // the history.
  assert.deepEqual(Object.keys(updated), Object.keys(baseTranslated));
});

test('a lost substitution cancels the whole import', () => {
  const rows = [
    { key: 'Save', proposed: 'Записать' },
    { key: 'Hello', proposed: 'Привет' }
  ];
  const { updated, problems } = applyReview({ source: baseSource, translated: baseTranslated, rows });
  assert.equal(updated, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Hello/);
});

test('an unknown key cancels the import', () => {
  const { updated, problems } = applyReview({
    source: baseSource,
    translated: baseTranslated,
    rows: [{ key: 'Nope', proposed: 'Нет' }]
  });
  assert.equal(updated, null);
  assert.match(problems[0], /Nope/);
});

test('an extra count is allowed: it is passed to the number forms', () => {
  const { problems } = applyReview({
    source: { Files: 'Files' },
    translated: { Files: 'Файлы' },
    rows: [{ key: 'Files', proposed: 'Файлов: {{count}}' }]
  });
  assert.deepEqual(problems, []);
});

test('substitution names', () => {
  assert.deepEqual([...placeholders('Привет, {{name}} и {{ count }}')].sort(), ['count', 'name']);
});
