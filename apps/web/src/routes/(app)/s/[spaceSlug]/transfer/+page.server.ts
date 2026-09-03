import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listImportTasks } from '$lib/features/page/services/transfer';
import { getSpace } from '$lib/features/space/services/spaces';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const space = await getSpace(params.spaceSlug, fetch, headers);
    // Перечень заданий не должен ронять экран: вывоз работает и без него.
    const tasks = await listImportTasks(undefined, fetch, headers).catch(() => ({
      items: [],
      meta: { limit: 0, hasNextPage: false, nextCursor: null }
    }));
    return { space, tasks: tasks.items };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
