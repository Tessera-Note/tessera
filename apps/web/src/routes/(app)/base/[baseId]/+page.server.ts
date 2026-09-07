import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { baseInfo, baseRows } from '$lib/features/base/services/bases';
import { spaceMembers } from '$lib/features/space/services/spaces';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request, parent }) => {
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

    // Пространство берётся из слоя приложения: оно уже загружено там. Нужно
    // оно ради короткого имени в адресе — уходить после удаления базы некуда,
    // сама база к этому времени в корзине.
    const { spaces } = await parent();
    return {
      base,
      rows,
      members,
      space: spaces.find((one) => one.id === base.spaceId) ?? null
    };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
