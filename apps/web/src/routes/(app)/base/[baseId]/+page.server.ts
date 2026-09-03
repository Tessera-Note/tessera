import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { baseInfo, baseRows } from '$lib/features/base/services/bases';
import { spaceMembers } from '$lib/features/space/services/spaces';
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

    // Участники пространства нужны ячейке с человеком: сервер разворачивает
    // вместе со строками только авторов правок, а в ячейке может стоять
    // кто угодно из пространства. Отказ не роняет базу — ячейка покажет
    // идентификатор вместо имени.
    const members = await spaceMembers(base.spaceId, fetch, headers).catch(() => []);
    return { base, rows, members };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
