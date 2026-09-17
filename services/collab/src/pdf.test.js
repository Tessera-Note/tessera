/**
 * Parsing a PDF.
 *
 * The library itself is not tested here: it was tested on real files in the
 * earlier version, and a second such measurement would add nothing. What is
 * tested is everything around it: an empty file, a refused parse, a scan with
 * no text layer, and the conversion of markdown into markup.
 *
 * The fixtures are deliberately Cyrillic: that a heading and a paragraph in
 * Cyrillic survive the conversion is part of what this file checks.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { htmlFromPdf, PDF_EMPTY, PDF_NO_TEXT_LAYER, PDF_UNREADABLE } from './pdf.js';

/** A stub parser: it answers with whatever it was given. */
function parser(answer) {
  return () => answer;
}

const SOME_PDF = Buffer.from('%PDF-1.4 что-то').toString('base64');

test('markdown is turned into markup', async () => {
  const html = await htmlFromPdf(
    SOME_PDF,
    parser({ markdown: '# Регламент\n\nтекст', pdfType: 'Text' }),
  );
  assert.match(html, /<h1[^>]*>Регламент<\/h1>/);
  assert.match(html, /текст/);
});

test('an empty file is refused', async () => {
  await assert.rejects(() => htmlFromPdf('', parser({})), { message: PDF_EMPTY });
});

test('a file that did not parse is refused with its own reason', async () => {
  await assert.rejects(
    () =>
      htmlFromPdf(SOME_PDF, () => {
        throw new Error('an internal breakage of the library');
      }),
    { message: PDF_UNREADABLE },
  );
});

test('a scan with no text layer is refused', async () => {
  // An empty page instead of a document would look like a successful import.
  await assert.rejects(
    () => htmlFromPdf(SOME_PDF, parser({ markdown: 'что-то', pdfType: 'Scanned' })),
    { message: PDF_NO_TEXT_LAYER },
  );
});

test('an empty parse is refused the same way as a scan', async () => {
  await assert.rejects(
    () => htmlFromPdf(SOME_PDF, parser({ markdown: '   ', pdfType: 'Text' })),
    { message: PDF_NO_TEXT_LAYER },
  );
});
