import * as fs from 'fs';
import * as path from 'path';

/**
 * `const { trx } = opts;` при `opts?: {...}` роняет вызов без аргумента.
 *
 * Девять таких мест жили в репозиториях незамеченными: все нынешние вызывающие
 * аргумент передают, поэтому падения не было, а сигнатура обещала
 * необязательность, которой нет. Заметить это по сборке нельзя, в проекте
 * выключен `strictNullChecks`.
 *
 * Проверяется правило, а не список файлов: необязательный аргумент читается
 * через `opts?.поле`, а не разбирается на части.
 */
const SRC = path.resolve(__dirname, '..');

/** Разбор необязательного аргумента: `const { что-то } = opts;`. */
const DESTRUCTURING = /\n\s*const \{[^}]+\} = opts;/g;

/** Объявление аргумента необязательным в ближайшей сигнатуре выше. */
const OPTIONAL_PARAM = /opts\?\s*:/;

function sources(dir: string): string[] {
  const found: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.')) {
      found.push(full);
    }
  }

  return found;
}

describe('Необязательный аргумент opts', () => {
  it('не разбирается на части там, где его могут не передать', () => {
    const offenders: string[] = [];

    for (const file of sources(SRC)) {
      const text = fs.readFileSync(file, 'utf8');

      for (const match of text.matchAll(DESTRUCTURING)) {
        const before = text.slice(Math.max(0, match.index - 900), match.index);
        const signature = before.slice(before.lastIndexOf('async '));
        if (!OPTIONAL_PARAM.test(signature)) continue;

        const line = text.slice(0, match.index).split('\n').length + 1;
        offenders.push(`${path.relative(SRC, file)}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
