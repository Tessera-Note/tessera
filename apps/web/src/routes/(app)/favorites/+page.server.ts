import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listFavorites } from '$lib/features/page/services/favorites';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    return { favorites: await listFavorites(fetch, headers) };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
