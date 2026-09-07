import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listShares } from '$lib/features/share/services/list';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const found = await listShares({}, fetch, headers);
    return { shares: found.items, nextCursor: found.meta.nextCursor };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
