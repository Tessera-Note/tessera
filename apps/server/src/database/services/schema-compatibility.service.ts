import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Migrator, FileMigrationProvider } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';

/**
 * Отказ на старте, если схема новее сборки.
 *
 * Откат приложения на предыдущую версию, когда база уже переехала вперед, не
 * возвращает прежнее поведение: новая схема может содержать ограничения,
 * которых старый код не соблюдает. Пример из истории проекта: нормализация
 * jsonb в модуле base поставила `CHECK jsonb_typeof(...) = 'object'`, и
 * предыдущая версия, писавшая туда json-строку, молча переходила в режим
 * только чтения. Запись падала с 23514 на каждой операции, а оператор видел
 * это уже по жалобам пользователей.
 *
 * Проверка сравнивает миграции, применённые в базе, с теми, что есть в этой
 * сборке. Лишние в базе означают, что схема ушла вперёд, и сборку запускать
 * нельзя.
 *
 * Обратный случай, когда сборка новее базы, здесь не рассматривается: его
 * закрывает штатный прогон миграций, он идёт до этой проверки.
 *
 * Ограничение, о котором надо помнить: проверка защищает только откаты на
 * версии, где она уже есть. Откат на сборку, выпущенную до её появления,
 * по-прежнему держится на процедуре выката.
 */
@Injectable()
export class SchemaCompatibilityService {
  private readonly logger = new Logger(
    `Database${SchemaCompatibilityService.name}`,
  );

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async assertSchemaIsNotAhead(): Promise<void> {
    const migrator = new Migrator({
      db: this.db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(__dirname, '..', 'migrations'),
      }),
    });

    const migrations = await migrator.getMigrations();
    const unknown = migrations
      .filter((migration) => migration.executedAt && !migration.migration)
      .map((migration) => migration.name);

    if (unknown.length === 0) {
      return;
    }

    this.logger.error(
      'Схема базы новее этой сборки. В базе применены миграции, которых в ' +
        `сборке нет: ${unknown.join(', ')}. Запуск остановлен: старый код на ` +
        'новой схеме может нарушать её ограничения и терять записи. Либо ' +
        'разверните сборку, соответствующую схеме, либо откатите лишние ' +
        'миграции.',
    );
    process.exit(1);
  }
}
