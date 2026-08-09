import api from "@/lib/api-client";
import {
  ICurrentUser,
  IMentionTarget,
  IUser,
} from "@/features/user/types/user.types";

export async function getMyInfo(): Promise<ICurrentUser> {
  const req = await api.post<ICurrentUser>("/users/me");
  return req.data as ICurrentUser;
}

export async function updateUser(data: Partial<IUser>): Promise<IUser> {
  const req = await api.post<IUser>("/users/update", data);
  return req.data as IUser;
}

/**
 * Кто стоит за упоминаниями в содержимом.
 *
 * Подпись в узле упоминания заморожена на момент вставки, поэтому имя
 * удаленного человека оставалось в теле каждой страницы, где его упомянули.
 * Разрешение на лету закрывает это, не переписывая страницы.
 */
export async function resolveMentions(
  userIds: string[],
): Promise<IMentionTarget[]> {
  if (userIds.length === 0) return [];
  const req = await api.post<IMentionTarget[]>("/users/mentions", { userIds });
  return req.data;
}
