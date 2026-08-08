export type TextChunk = { text: string; start: number };

// Roughly 350 tokens per chunk for English or Portuguese prose, which keeps a
// chunk small enough to be a precise match but large enough to carry context.
const TARGET_CHARS = 1400;
const OVERLAP_CHARS = 200;
const MIN_CHARS = 40;

/**
 * Split text into overlapping chunks, preferring to break at a paragraph or
 * sentence boundary so a chunk does not start mid-thought.
 *
 * `start` is the offset into the original text, which lets the caller slice an
 * excerpt back out without storing the chunk body twice.
 */
export function chunkText(text: string): TextChunk[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length < MIN_CHARS) return [];

  const chunks: TextChunk[] = [];
  let cursor = 0;

  while (cursor < clean.length) {
    const hardEnd = Math.min(cursor + TARGET_CHARS, clean.length);
    let end = hardEnd;

    if (hardEnd < clean.length) {
      // Look for a boundary in the last third of the window; anything earlier
      // would make the chunk needlessly small.
      const windowStart = cursor + Math.floor(TARGET_CHARS * 0.6);
      const candidates = [
        clean.lastIndexOf('\n\n', hardEnd),
        clean.lastIndexOf('. ', hardEnd),
        clean.lastIndexOf('\n', hardEnd),
      ].filter((i) => i > windowStart);

      if (candidates.length > 0) {
        end = Math.max(...candidates) + 1;
      }
    }

    const body = clean.slice(cursor, end).trim();
    if (body.length >= MIN_CHARS) {
      chunks.push({ text: body, start: clean.indexOf(body, cursor) });
    }

    if (end >= clean.length) break;
    // Step back a little so a sentence spanning the cut is present whole in
    // one of the two chunks.
    cursor = Math.max(end - OVERLAP_CHARS, cursor + 1);
  }

  return chunks;
}
