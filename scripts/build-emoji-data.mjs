/**
 * Building the emoji list for the editor.
 *
 * Run by hand; the result is put into the sources and committed:
 * `node scripts/build-emoji-data.mjs`.
 *
 * Why the set is not read at runtime. The `@slidoapp/emoji-mart-data` package
 * would have to be declared as a dependency of `apps/web` for the sake of a
 * hundred kilobytes of unchanging data. The set does not change between builds,
 * so it is taken once and lives in the repository as an ordinary file.
 *
 * This script reads the package from the shared `node_modules` and is not part
 * of the build.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const source = resolve(root, 'node_modules/@slidoapp/emoji-mart-data/sets/15/native.json');
const target = resolve(root, 'apps/web/src/lib/features/editor/emoji-data.ts');

const data = JSON.parse(readFileSync(source, 'utf8'));

const rows = [];
for (const entry of Object.values(data.emojis)) {
  const native = entry?.skins?.[0]?.native;
  if (!entry?.id || !entry?.name || !native) continue;

  // The words to search by: the name and the keywords in one lowercase string.
  // The search goes by substring, and there is no reason to keep them parsed —
  // parsing on every keystroke would cost more than the search itself.
  const words = [entry.name, ...(entry.keywords ?? [])]
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  rows.push([native, entry.id, words]);
}

rows.sort((a, b) => a[1].localeCompare(b[1]));

const quote = (value) => JSON.stringify(value);
const body = rows.map((row) => `  [${row.map(quote).join(', ')}]`).join(',\n');

writeFileSync(
  target,
  `/**
 * The emoji list: the character, the name, the words to search by.
 *
 * The file is built by the \`scripts/build-emoji-data.mjs\` script and is edited
 * only by it. It is read on demand — by picking after ":" — so it is not part of
 * the common bundle.
 */

export type EmojiRow = readonly [native: string, id: string, words: string];

export const EMOJI: readonly EmojiRow[] = [
${body}
];
`,
  'utf8'
);

// Laying out the lines is prettier's business, not this script's. Repeating its
// rules by hand is pointless: it counts the width of a character by how it
// looks rather than by the length of the string, and composite emoji take less
// space for it than they do in the code. Without this step the file would lie in
// the sources unformatted and would not pass `pnpm lint`.
execFileSync('npx', ['prettier', '--write', target], {
  cwd: resolve(root, 'apps/web'),
  stdio: 'ignore'
});

console.log(`emoji: ${rows.length}`);
