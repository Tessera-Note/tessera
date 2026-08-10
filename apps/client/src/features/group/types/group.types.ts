export interface IGroup {
  groupId: string;
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  /**
   * Какой каталог ведет группу: 'scim', 'sso' или ничего. Пока каталог ее
   * ведет, менять и удалять группу изнутри нельзя.
   */
  directorySource?: string | null;
  /** Провайдер SSO, ведущий группу. У источника scim пусто. */
  directoryProviderId?: string | null;
  /** Ключ группы на стороне каталога, по нему идет сопоставление. */
  directoryKey?: string | null;
  creatorId: string | null;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
  memberCount: number;
}
