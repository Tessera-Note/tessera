/**
 * Parsing a PDF into HTML.
 *
 * Here rather than on the Python side, because the quality of the parsing is a
 * property of the library rather than of the language: `@docmost/pdf-inspector`
 * returns markdown with headings and lists, while `pypdf` returns bare text and
 * an imported document lost all of its structure. The package is declared in
 * the root `package.json`: `services` is not part of the pnpm workspace, and
 * the package manager does not read a manifest here. And the conversion service
 * exists for exactly this — HTML, Markdown and the DOCX export already live in
 * it.
 *
 * What is carried over was measured on real files in the earlier version:
 * headings with levels, paragraphs, bulleted lists, Cyrillic text. What is
 * lost: the styling inside a line, tables and images — the library does not
 * return them even where the document has them, so their transfer cannot be
 * promised.
 */
import { createRequire } from 'node:module';

import { markdownToHtml } from './extensions.js';

const require = createRequire(import.meta.url);

/** The kinds of PDF that have no text layer at all. */
const WITHOUT_TEXT = new Set(['Scanned', 'ImageBased']);

/**
 * The reasons for a failure. They travel as a code rather than as text: the
 * translation lives on the side that talks to a person, and a second set of it
 * here would diverge from the first.
 */
export const PDF_EMPTY = 'pdf_empty';
export const PDF_UNREADABLE = 'pdf_unreadable';
export const PDF_NO_TEXT_LAYER = 'pdf_no_text_layer';

/**
 * Parse a PDF.
 *
 * The library is loaded on the first call rather than at startup: the service
 * is brought up for collaborative editing, and parsing a PDF is not part of
 * that path.
 */
export async function htmlFromPdf(base64, parser) {
  const bytes = Buffer.from(base64 || '', 'base64');
  if (!bytes.length) throw new Error(PDF_EMPTY);

  const processPdf = parser ?? require('@docmost/pdf-inspector').processPdf;

  let parsed;
  try {
    parsed = processPdf(bytes);
  } catch {
    throw new Error(PDF_UNREADABLE);
  }

  const markdown = (parsed?.markdown ?? '').trim();
  if (WITHOUT_TEXT.has(parsed?.pdfType) || !markdown) {
    // A scan with no text layer. Getting text out of it takes recognition,
    // which the deployment does not have, and an empty page instead of a
    // document would look like a successful import.
    throw new Error(PDF_NO_TEXT_LAYER);
  }

  return await markdownToHtml(markdown);
}
