import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { baseInfo, baseRows } from '$lib/features/base/services/bases';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Описание и строки независимы: последовательные ждали бы друг друга без
    // причины.
    const [base, rows] = await Promise.all([
      baseInfo(params.baseId, fetch, headers),
      baseRows(params.baseId, undefined, fetch, headers)
    ]);
    return { base, rows };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
