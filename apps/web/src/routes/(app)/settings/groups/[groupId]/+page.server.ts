import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { groupInfo, groupMembers } from '$lib/features/group/services/groups';
import { listProviders } from '$lib/features/sso/services/providers';
import { listMembers } from '$lib/features/workspace/services/members';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Все три запроса независимы, и последовательные ждали бы друг друга без
    // причины. Перечень людей рабочего пространства нужен для добавления в
    // группу: сервер отдаёт его только администратору, и этот экран тоже его.
    const [group, members, people, providers] = await Promise.all([
      groupInfo(params.groupId, fetch, headers),
      groupMembers(params.groupId, fetch, headers),
      listMembers(fetch, headers),
      // Провайдеры нужны для выбора того, кто будет вести состав группы.
      // Отказ здесь не должен закрывать экран: провайдеров может не быть
      // вовсе, и группа от этого не перестаёт открываться.
      listProviders(fetch, headers).catch(() => ({ items: [] }))
    ]);
    return { group, members, people, providers: providers.items };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
