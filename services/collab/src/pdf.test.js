/**
 * Разбор PDF.
 *
 * Сама библиотека здесь не проверяется: она проверена в v1 на настоящих
 * файлах, и второй такой замер ничего не добавит. Проверяется то, что вокруг
 * неё: пустой файл, отказ разбора, скан без текстового слоя и превращение
 * markdown в разметку.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { htmlFromPdf, PDF_EMPTY, PDF_NO_TEXT_LAYER, PDF_UNREADABLE } from './pdf.js';

/** Разборщик-двойник: отвечает тем, что ему задали. */
function parser(answer) {
  return () => answer;
}

const SOME_PDF = Buffer.from('%PDF-1.4 что-то').toString('base64');

test('markdown превращается в разметку', async () => {
  const html = await htmlFromPdf(
    SOME_PDF,
    parser({ markdown: '# Регламент\n\nтекст', pdfType: 'Text' }),
  );
  assert.match(html, /<h1[^>]*>Регламент<\/h1>/);
  assert.match(html, /текст/);
});

test('пустой файл отвергается', async () => {
  await assert.rejects(() => htmlFromPdf('', parser({})), { message: PDF_EMPTY });
});

test('неразобранный файл отвергается своей причиной', async () => {
  await assert.rejects(
    () =>
      htmlFromPdf(SOME_PDF, () => {
        throw new Error('внутренняя поломка библиотеки');
      }),
    { message: PDF_UNREADABLE },
  );
});

test('скан без текстового слоя отвергается', async () => {
  // Пустая страница вместо документа выглядела бы успешным ввозом.
  await assert.rejects(
    () => htmlFromPdf(SOME_PDF, parser({ markdown: 'что-то', pdfType: 'Scanned' })),
    { message: PDF_NO_TEXT_LAYER },
  );
});

test('пустой разбор отвергается так же, как скан', async () => {
  await assert.rejects(
    () => htmlFromPdf(SOME_PDF, parser({ markdown: '   ', pdfType: 'Text' })),
    { message: PDF_NO_TEXT_LAYER },
  );
});
