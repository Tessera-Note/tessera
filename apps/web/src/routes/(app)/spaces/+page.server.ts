import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listSpaces, personalSpace } from '$lib/features/space/services/spaces';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const [spaces, personal] = await Promise.all([
      listSpaces(fetch, headers),
      personalSpace(fetch, headers)
    ]);
    return { spaces, personal };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
