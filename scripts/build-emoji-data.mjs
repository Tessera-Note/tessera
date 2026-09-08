/**
 * Сборка перечня эмодзи для редактора v2.
 *
 * Запускается руками, результат кладётся в исходники и коммитится:
 * `node scripts/build-emoji-data.mjs`.
 *
 * Почему не читать набор в рантайме, как это делает v1. Пакет
 * `@slidoapp/emoji-mart-data` объявлен зависимостью `apps/client`, и его же
 * зависимостью `apps/web` был бы второй объявленный пакет ради ста килобайт
 * неизменных данных. Набор не меняется между сборками, поэтому он снимается
 * один раз и живёт в репозитории обычным файлом.
 *
 * Пакет остаётся зависимостью первой версии: этот сценарий читает его из
 * общего `node_modules` и в сборку второй версии не входит.
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

  // Слова для поиска: имя и ключевые слова одной строкой в нижнем регистре.
  // Поиск идёт подстрокой, и держать их разобранными незачем — разбор на
  // каждый ввод стоил бы дороже самого поиска.
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
 * Перечень эмодзи: знак, имя, слова для поиска.
 *
 * Файл собран сценарием \`scripts/build-emoji-data.mjs\` и правится только им.
 * Читается по требованию — подбором по «:», поэтому в общую сборку не входит.
 */

export type EmojiRow = readonly [native: string, id: string, words: string];

export const EMOJI: readonly EmojiRow[] = [
${body}
];
`,
  'utf8'
);

// Раскладка строк — дело prettier, а не этого сценария. Повторять его правила
// вручную бессмысленно: он считает ширину знака по виду, а не по длине строки,
// и составные эмодзи занимают у него меньше, чем в коде. Без этого шага файл
// лежал бы в исходниках неотформатированным и не проходил бы `pnpm lint`.
execFileSync('npx', ['prettier', '--write', target], {
  cwd: resolve(root, 'apps/web'),
  stdio: 'ignore'
});

console.log(`эмодзи: ${rows.length}`);
