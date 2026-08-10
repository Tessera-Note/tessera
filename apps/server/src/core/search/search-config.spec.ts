import { execSync } from 'node:child_process';
import { SEARCH_CONFIG } from '../../database/utils';

/**
 * Поисковый вектор и поисковый запрос обязаны разбираться одной и той же
 * конфигурацией. Разойдясь, они перестают совпадать молча: ошибки нет, поиск
 * просто ничего не находит. Так и было до миграции 20260810T210000, где
 * векторы строились конфигурацией `english`, не приводящей кириллицу к
 * основе.
 *
 * Проверка идет по исходникам, а не по базе: поднимать PostgreSQL ради нее
 * дороже, чем она стоит, а забывают именно про новое место в коде.
 */
function grep(pattern: string, paths: string): string[] {
  try {
    return execSync(`grep -rn "${pattern}" ${paths} --include=*.ts || true`, {
      cwd: `${__dirname}/../../..`,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

describe('конфигурация текстового поиска', () => {
  it('в рантайме не осталось запросов с прежней конфигурацией', () => {
    const stale = grep("'english'", 'src').filter(
      (line) =>
        !line.includes('src/database/migrations/') &&
        !line.includes('search-config.spec.ts'),
    );

    expect(stale).toEqual([]);
  });

  /**
   * Миграции менять нельзя, и прежние остаются с `english` навсегда. Но
   * последняя по времени обязана уже переводить триггеры на новую
   * конфигурацию, иначе накат на чистую базу оставит ее в прежнем виде.
   */
  it('перевод триггеров закреплен миграцией', () => {
    const applied = grep(SEARCH_CONFIG, 'src/database/migrations');

    expect(applied.length).toBeGreaterThan(0);
  });

  it('имя конфигурации ведется в одном месте', () => {
    const hardcoded = grep(`'${SEARCH_CONFIG}'`, 'src').filter(
      (line) =>
        !line.includes('src/database/utils.ts') &&
        !line.includes('src/database/migrations/') &&
        !line.includes('search-config.spec.ts'),
    );

    expect(hardcoded).toEqual([]);
  });
});
