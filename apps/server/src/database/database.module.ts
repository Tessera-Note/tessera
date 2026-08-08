import { Global, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { InjectKysely, KyselyModule } from 'nestjs-kysely';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { CamelCasePlugin, LogEvent, sql } from 'kysely';
import { GroupRepo } from '@tessera/db/repos/group/group.repo';
import { WorkspaceRepo } from '@tessera/db/repos/workspace/workspace.repo';
import { WorkspaceAiSettingsRepo } from '@tessera/db/repos/workspace/workspace-ai-settings.repo';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { GroupUserRepo } from '@tessera/db/repos/group/group-user.repo';
import { SpaceRepo } from '@tessera/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { PageRepo } from './repos/page/page.repo';
import { PagePermissionRepo } from './repos/page/page-permission.repo';
import { CommentRepo } from './repos/comment/comment.repo';
import { PageTransclusionsRepo } from './repos/page-transclusions/page-transclusions.repo';
import { PageTransclusionReferencesRepo } from './repos/page-transclusions/page-transclusion-references.repo';
import { PageHistoryRepo } from './repos/page/page-history.repo';
import { AttachmentRepo } from './repos/attachment/attachment.repo';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import * as process from 'node:process';
import { MigrationService } from '@tessera/db/services/migration.service';
import { BaseRepo } from '@tessera/db/repos/base/base.repo';
import { SchemaCompatibilityService } from '@tessera/db/services/schema-compatibility.service';
import { UserTokenRepo } from './repos/user-token/user-token.repo';
import { UserSessionRepo } from '@tessera/db/repos/session/user-session.repo';
import { BacklinkRepo } from '@tessera/db/repos/backlink/backlink.repo';
import { ShareRepo } from '@tessera/db/repos/share/share.repo';
import { NotificationRepo } from '@tessera/db/repos/notification/notification.repo';
import { WatcherRepo } from '@tessera/db/repos/watcher/watcher.repo';
import { LabelRepo } from '@tessera/db/repos/label/label.repo';
import { FavoriteRepo } from '@tessera/db/repos/favorite/favorite.repo';
import { TemplateRepo } from '@tessera/db/repos/template/template.repo';
import { ApiKeyRepo } from '@tessera/db/repos/api-key/api-key.repo';
import { ScimTokenRepo } from '@tessera/db/repos/scim-token/scim-token.repo';
import { ScimUserRepo } from '@tessera/db/repos/scim-user/scim-user.repo';
import { ScimGroupRepo } from '@tessera/db/repos/scim-group/scim-group.repo';
import { PageListener } from '@tessera/db/listeners/page.listener';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../common/helpers';

@Global()
@Module({
  imports: [
    KyselyModule.forRootAsync({
      imports: [],
      inject: [EnvironmentService],
      useFactory: (environmentService: EnvironmentService) => ({
        dialect: new PostgresJSDialect({
          postgres: postgres(
            normalizePostgresUrl(environmentService.getDatabaseURL()),
            {
              max: environmentService.getDatabaseMaxPool(),
              onnotice: () => {},
              types: {
                bigint: {
                  to: 20,
                  from: [20, 1700],
                  serialize: (value: number) => value.toString(),
                  parse: (value: string) => Number.parseInt(value),
                },
              },
            },
          ),
        }),
        plugins: [new CamelCasePlugin()],
        log: (event: LogEvent) => {
          if (environmentService.getNodeEnv() !== 'development') return;
          const logger = new Logger(DatabaseModule.name);
          if (process.env.DEBUG_DB?.toLowerCase() === 'true') {
            logger.debug(event.query.sql);
            logger.debug('query time: ' + event.queryDurationMillis + ' ms');
          }
        },
      }),
    }),
  ],
  providers: [
    MigrationService,
    SchemaCompatibilityService,
    BaseRepo,
    WorkspaceRepo,
    WorkspaceAiSettingsRepo,
    UserRepo,
    GroupRepo,
    GroupUserRepo,
    SpaceRepo,
    SpaceMemberRepo,
    PageRepo,
    PagePermissionRepo,
    PageTransclusionsRepo,
    PageTransclusionReferencesRepo,
    PageHistoryRepo,
    CommentRepo,
    FavoriteRepo,
    AttachmentRepo,
    UserTokenRepo,
    UserSessionRepo,
    BacklinkRepo,
    ShareRepo,
    NotificationRepo,
    WatcherRepo,
    LabelRepo,
    TemplateRepo,
    ApiKeyRepo,
    ScimTokenRepo,
    ScimUserRepo,
    ScimGroupRepo,
    PageListener,
  ],
  exports: [
    BaseRepo,
    WorkspaceRepo,
    WorkspaceAiSettingsRepo,
    UserRepo,
    GroupRepo,
    GroupUserRepo,
    SpaceRepo,
    SpaceMemberRepo,
    PageRepo,
    PagePermissionRepo,
    PageTransclusionsRepo,
    PageTransclusionReferencesRepo,
    PageHistoryRepo,
    CommentRepo,
    FavoriteRepo,
    AttachmentRepo,
    UserTokenRepo,
    UserSessionRepo,
    BacklinkRepo,
    ShareRepo,
    NotificationRepo,
    WatcherRepo,
    LabelRepo,
    TemplateRepo,
    ApiKeyRepo,
    ScimTokenRepo,
    ScimUserRepo,
    ScimGroupRepo,
  ],
})
export class DatabaseModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly migrationService: MigrationService,
    private readonly schemaCompatibilityService: SchemaCompatibilityService,
    private readonly environmentService: EnvironmentService,
  ) {}

  async onApplicationBootstrap() {
    await this.establishConnection();

    if (this.environmentService.getNodeEnv() === 'production') {
      await this.migrationService.migrateToLatest();
      // После штатного прогона: если в базе остались миграции, которых нет в
      // этой сборке, значит запущена версия старее схемы. Дальше идти нельзя.
      await this.schemaCompatibilityService.assertSchemaIsNotAhead();
    }
  }

  async establishConnection() {
    const retryAttempts = 15;
    const retryDelay = 3000;

    this.logger.log('Establishing database connection');
    for (let i = 0; i < retryAttempts; i++) {
      try {
        await sql`SELECT 1=1`.execute(this.db);
        this.logger.log('Database connection successful');
        break;
      } catch (err) {
        if (err['errors']) {
          this.logger.error(err['errors'][0]);
        } else {
          this.logger.error(err);
        }

        if (i < retryAttempts - 1) {
          this.logger.log(
            `Retrying [${i + 1}/${retryAttempts}] in ${retryDelay / 1000} seconds`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        } else {
          this.logger.error(
            `Failed to connect to database after ${retryAttempts} attempts. Exiting...`,
          );
          process.exit(1);
        }
      }
    }
  }
}
