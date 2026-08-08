import { Json, Timestamp, Generated } from '@tessera/db/types/db';

// embeddings type
export interface PageEmbeddings {
  id: Generated<string>;
  pageId: string;
  spaceId: string;
  modelName: string;
  /**
   * Провайдер, которым посчитан вектор. Часть идентичности векторного
   * пространства наравне с именем модели: одно и то же имя у разных
   * провайдеров дает разные векторы.
   */
  driver: string | null;
  modelDimensions: number;
  workspaceId: string;
  // Nullable in the schema: a chunk comes either from a page body or from an
  // attachment extracted for that page.
  attachmentId: string | null;
  embedding: number[];
  chunkIndex: Generated<number>;
  chunkStart: Generated<number>;
  chunkLength: Generated<number>;
  metadata: Generated<Json>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
  deletedAt: Timestamp | null;
}
