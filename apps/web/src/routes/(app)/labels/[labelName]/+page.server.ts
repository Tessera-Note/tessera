import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { pagesWithLabel } from '$lib/features/page/services/labels';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const name = decodeURIComponent(params.labelName);
    return { name, pages: await pagesWithLabel(name, fetch, headers) };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
