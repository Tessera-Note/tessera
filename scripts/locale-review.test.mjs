/**
 * Проверки вычитки словарей по частям.
 *
 * Проверяются правила, от которых зависит, что носитель прочитает нужное и
 * ничего не сломает: в выгрузку попадает только изменённое с прошлой вычитки,
 * таблица переживает круг «выгрузил — поправил в редакторе — внёс», а внесение
 * с неверной подстановкой не пишет ничего.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { REASON, applyReview, parseCsv, pendingRows, placeholders, toCsv } from './locale-review.mjs';

const baseSource = { Save: 'Save', Hello: 'Hello, {{name}}', Old: 'Old text' };
const baseTranslated = { Save: 'Сохранить', Hello: 'Привет, {{name}}', Old: 'Старый текст' };

test('без отметки выгружается всё', () => {
  const rows = pendingRows({ source: baseSource, translated: baseTranslated });
  assert.deepEqual(
    rows.map((one) => one.reason),
    [REASON.never, REASON.never, REASON.never]
  );
});

test('с отметкой — только изменённое после неё', () => {
  const source = { ...baseSource, Old: 'Reworded text', Fresh: 'Fresh' };
  const translated = { ...baseTranslated, Save: 'Сохранить изменения', Fresh: 'Свежее' };
  const rows = pendingRows({ source, translated, baseSource, baseTranslated });
  const byKey = Object.fromEntries(rows.map((one) => [one.key, one.reason]));
  assert.deepEqual(byKey, {
    Save: REASON.translation,
    Old: REASON.source,
    Fresh: REASON.added
  });
  // Нетронутая строка в выгрузку не попадает: ради этого выгрузка и частичная.
  assert.equal('Hello' in byKey, false);
});

test('ключ источника без перевода тоже попадает к вычитке', () => {
  const source = { ...baseSource, Missing: 'Missing' };
  const rows = pendingRows({ source, translated: baseTranslated, baseSource, baseTranslated });
  assert.deepEqual(
    rows.map((one) => [one.key, one.current, one.reason]),
    [['Missing', '', REASON.added]]
  );
});

test('формы числа сверяются с формой other источника', () => {
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

test('таблица переживает круг через CSV', () => {
  const rows = [
    { key: 'Hello', english: 'Hello, "friend"', current: 'Привет,\nдруг', reason: REASON.never, proposed: '' }
  ];
  const back = parseCsv(toCsv(rows));
  assert.deepEqual(back, rows);
});

test('разбор принимает точку с запятой и метку порядка байтов', () => {
  const text = '\uFEFFkey;english;current;reason;proposed\r\n"Save";"Save";"Сохранить";"new";"Записать"\r\n';
  assert.deepEqual(parseCsv(text), [
    { key: 'Save', english: 'Save', current: 'Сохранить', reason: 'new', proposed: 'Записать' }
  ]);
});

test('при запятой-разделителе точка с запятой остаётся текстом', () => {
  const text = 'key,english,current,reason,proposed\n"Save","Save",Сохранить; записать,new,\n';
  assert.equal(parseCsv(text)[0].current, 'Сохранить; записать');
});

test('таблица без столбца proposed не принимается', () => {
  assert.throws(() => parseCsv('key,english\n"Save","Save"\n'), /proposed/);
});

test('внесение меняет только заполненные строки', () => {
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
  // Порядок ключей файла не меняется: разница в истории читается.
  assert.deepEqual(Object.keys(updated), Object.keys(baseTranslated));
});

test('потерянная подстановка отменяет внесение целиком', () => {
  const rows = [
    { key: 'Save', proposed: 'Записать' },
    { key: 'Hello', proposed: 'Привет' }
  ];
  const { updated, problems } = applyReview({ source: baseSource, translated: baseTranslated, rows });
  assert.equal(updated, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Hello/);
});

test('неизвестный ключ отменяет внесение', () => {
  const { updated, problems } = applyReview({
    source: baseSource,
    translated: baseTranslated,
    rows: [{ key: 'Nope', proposed: 'Нет' }]
  });
  assert.equal(updated, null);
  assert.match(problems[0], /Nope/);
});

test('лишний count допустим: он передаётся формам числа', () => {
  const { problems } = applyReview({
    source: { Files: 'Files' },
    translated: { Files: 'Файлы' },
    rows: [{ key: 'Files', proposed: 'Файлов: {{count}}' }]
  });
  assert.deepEqual(problems, []);
});

test('имена подстановок', () => {
  assert.deepEqual([...placeholders('Привет, {{name}} и {{ count }}')].sort(), ['count', 'name']);
});
