import { Generated, Timestamp } from '@tessera/db/types/db';

/**
 * Per-workspace AI provider configuration. Every column is nullable: a null
 * field falls back to the matching environment variable, so an install that
 * only ever configured AI through the env keeps working untouched.
 *
 * Этот интерфейс подменяет сгенерированный одноименный через
 * `database/types/db.interface.ts`, поэтому новые колонки таблицы
 * описываются здесь руками. Править `db.d.ts` для них не нужно и нельзя.
 */
export interface WorkspaceAiSettings {
  id: Generated<string>;
  workspaceId: string;
  driver: string | null;
  baseUrl: string | null;
  /** AES-256-GCM ciphertext. Never leaves the server. */
  apiKeyEncrypted: string | null;
  chatModel: string | null;
  completionModel: string | null;
  /** Пустое значение означает «тот же провайдер, что у чата». */
  embeddingDriver: string | null;
  embeddingBaseUrl: string | null;
  embeddingApiKeyEncrypted: string | null;
  embeddingModel: string | null;
  /** Источник поиска в интернете: searxng, tavily, brave, off. */
  webSearchDriver: string | null;
  webSearchBaseUrl: string | null;
  /** AES-256-GCM ciphertext. Never leaves the server. */
  webSearchApiKeyEncrypted: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}
