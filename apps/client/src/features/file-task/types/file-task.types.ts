export interface IFileTask {
  id: string;
  type: "import" | "export";
  source: string;
  status: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  fileExt: string;
  errorMessage: string | null;
  /**
   * Сведения о задаче. Для выгрузки PDF здесь бывает `truncatedAt`: предел, на
   * котором обход страниц оборвался. Без него человек считал бы усечённую
   * выгрузку полной.
   */
  metadata?: { truncatedAt?: number } | null;
  creatorId: string;
  spaceId: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
