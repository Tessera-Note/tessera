import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listInvitations, listMembers } from '$lib/features/workspace/services/members';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Приглашения видит только администратор, и сервер это проверяет. Отказ
    // здесь означает, что человек открыл экран не своего уровня, — экран
    // показывает список участников без приглашений.
    const [members, invited] = await Promise.all([
      listMembers(fetch, headers),
      listInvitations(fetch, headers).catch(() => ({ items: [], meta: { nextCursor: null } }))
    ]);
    return { members, invitations: invited.items };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
