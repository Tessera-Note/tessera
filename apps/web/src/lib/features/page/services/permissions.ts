import { post } from '$lib/api/client';

export type PagePermission = {
  id: string;
  userId: string | null;
  groupId: string | null;
  role: string;
  name?: string | null;
  email?: string | null;
};

export type PermissionInfo = {
  restrictionId: string | null;
  hasDirectRestriction: boolean;
  hasInheritedRestriction: boolean;
  userAccess: { canView: boolean; canEdit: boolean; canManage: boolean };
};

export function permissionInfo(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<PermissionInfo>('/api/pages/permission-info', { pageId }, { fetcher, headers });
}

export function listPermissions(
  pageId: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<PagePermission[]>('/api/pages/permissions', { pageId }, { fetcher, headers });
}

/**
 * Закрыть страницу.
 *
 * Ограничение заводится на самой странице и наследуется её ветвью: закрывать
 * каждую страницу отдельно значило бы оставить дыру на первой же новой
 * подстранице.
 */
export function restrictPage(pageId: string, fetcher?: typeof fetch) {
  return post<{ restrictionId: string; created: boolean }>(
    '/api/pages/restrict',
    { pageId },
    { fetcher }
  );
}

export function removeRestriction(pageId: string, fetcher?: typeof fetch) {
  return post<{ success: boolean }>('/api/pages/remove-restriction', { pageId }, { fetcher });
}

/** Дать доступ. Люди и группы передаются списками: их и добавляют пачкой. */
export function addPermission(
  values: { pageId: string; role: string; userIds?: string[]; groupIds?: string[] },
  fetcher?: typeof fetch
) {
  return post<{ added: number }>('/api/pages/add-permission', values, { fetcher });
}

/**
 * Поменять роль у того, кому доступ уже выдан.
 *
 * Отдельно от выдачи: снятие и выдача заново дают тот же итог, но проходят
 * двумя записями в журнале и на миг оставляют человека без доступа.
 */
export function updatePermission(
  values: { pageId: string; role: string; userId?: string; groupId?: string },
  fetcher?: typeof fetch
) {
  return post<{ success: boolean }>('/api/pages/update-permission', values, { fetcher });
}

export function removePermission(
  values: { pageId: string; userIds?: string[]; groupIds?: string[] },
  fetcher?: typeof fetch
) {
  return post<{ removed: number }>('/api/pages/remove-permission', values, { fetcher });
}
