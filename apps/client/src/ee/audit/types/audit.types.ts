export type IAuditLog = {
  id: string;
  workspaceId: string;
  actorId?: string;
  actorType: string;
  event: string;
  resourceType: string;
  resourceId?: string;
  spaceId?: string;
  /**
   * Имена измененных полей, без значений.
   *
   * Значения в журнал не пишутся сознательно: его читает администратор
   * рабочего пространства, которому доступ к самим страницам может быть
   * не открыт.
   */
  changes?: {
    fields?: string[];
  };
  metadata?: Record<string, any>;
  ipAddress?: string;
  createdAt: string;
  actor?: {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string;
  };
  resource?: {
    id: string;
    name: string;
    slug?: string;
    slugId?: string;
  };
};

export type IAuditLogParams = {
  event?: string;
  resourceType?: string;
  actorId?: string;
  spaceId?: string;
  startDate?: string;
  endDate?: string;
  cursor?: string;
  limit?: number;
};
