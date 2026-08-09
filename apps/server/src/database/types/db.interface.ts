import { DB, Workspaces } from '@tessera/db/types/db';
import { PageEmbeddings } from '@tessera/db/types/embeddings.types';
import { WorkspaceAiSettings } from '@tessera/db/types/ai-settings.types';
import { Generated } from '@tessera/db/types/db';

/**
 * Слой поправок к сгенерированным типам.
 *
 * kysely-codegen выводит `bigint` как `Int8`, то есть строку: драйвер по
 * умолчанию так их и отдаёт. В этом проекте настроен разбор bigint в число,
 * поэтому колонки хранения приводятся здесь, иначе арифметика над ними не
 * компилируется. Правится тут, а не в db.d.ts: тот файл генерируемый.
 */
interface WorkspacesWithNumericRetention extends Omit<
  Workspaces,
  'auditRetentionDays' | 'trashRetentionDays'
> {
  auditRetentionDays: Generated<number>;
  trashRetentionDays: Generated<number>;
}

export interface DbInterface extends Omit<DB, 'workspaces' | 'pageEmbeddings'> {
  pageEmbeddings: PageEmbeddings;
  workspaceAiSettings: WorkspaceAiSettings;
  workspaces: WorkspacesWithNumericRetention;
}
