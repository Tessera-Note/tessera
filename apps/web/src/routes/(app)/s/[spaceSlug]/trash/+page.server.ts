import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { trashedPages } from '$lib/features/page/services/pages';
import { getSpace } from '$lib/features/space/services/spaces';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const space = await getSpace(params.spaceSlug, fetch, headers);
    return { space, pages: await trashedPages(space.id, fetch, headers) };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
