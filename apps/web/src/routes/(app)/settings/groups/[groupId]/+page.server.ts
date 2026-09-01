import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { groupInfo, groupMembers } from '$lib/features/group/services/groups';
import { listMembers } from '$lib/features/workspace/services/members';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Все три запроса независимы, и последовательные ждали бы друг друга без
    // причины. Перечень людей рабочего пространства нужен для добавления в
    // группу: сервер отдаёт его только администратору, и этот экран тоже его.
    const [group, members, people] = await Promise.all([
      groupInfo(params.groupId, fetch, headers),
      groupMembers(params.groupId, fetch, headers),
      listMembers(fetch, headers)
    ]);
    return { group, members, people };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
