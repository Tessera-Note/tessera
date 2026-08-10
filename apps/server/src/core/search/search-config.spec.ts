import { execSync } from 'node:child_process';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import { SEARCH_CONFIG } from '../../database/utils';

/**
 * Поисковый вектор и поисковый запрос обязаны разбираться одной и той же
 * конфигурацией. Разойдясь, они перестают совпадать молча.
 *
 * Прежняя редакция этой проверки грепала исходники и потому пропустила
 * поломку худшего рода: имя конфигурации подставлялось через `sql.raw`, то
 * есть голым идентификатором. PostgreSQL читает такой идентификатор как имя
 * колонки, и каждый полнотекстовый запрос падал с «column tessera_search does
 * not exist». Греп по тексту этого не видит, поэтому запрос здесь
 * компилируется по-настоящему.
 */
const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

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
  it('имя конфигурации уходит в SQL литералом, а не идентификатором', () => {
    const compiled =
      sql`select to_tsquery(${sql.lit(SEARCH_CONFIG)}, ${'x'})`.compile(db);

    expect(compiled.sql).toContain(`to_tsquery('${SEARCH_CONFIG}'`);
  });

  /**
   * Тот самый способ подстановки, который сломал поиск. Проверка держит
   * разницу видимой: сама по себе она ничего не запрещает, но объясняет,
   * почему запрет ниже не стилистический.
   */
  it('подстановка идентификатором дает другой SQL', () => {
    const compiled =
      sql`select to_tsquery(${sql.raw(SEARCH_CONFIG)}, ${'x'})`.compile(db);

    expect(compiled.sql).toContain(`to_tsquery(${SEARCH_CONFIG},`);
    expect(compiled.sql).not.toContain(`'${SEARCH_CONFIG}'`);
  });

  it('в рантайме конфигурация не подставляется идентификатором', () => {
    const raw = grep('sql\\.raw(SEARCH_CONFIG)', 'src').filter(
      (line) => !line.includes('search-config.spec.ts'),
    );

    expect(raw).toEqual([]);
  });

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
