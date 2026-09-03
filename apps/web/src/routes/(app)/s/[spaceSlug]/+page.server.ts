import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { getSpace, spaceWatchStatus } from '$lib/features/space/services/spaces';
import { pageTree } from '$lib/features/page/services/pages';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const space = await getSpace(params.spaceSlug, fetch, headers);
    // Корень дерева: у страниц верхнего уровня родителя нет.
    const pages = await pageTree(space.id, null, fetch, headers);
    // Состояние подписки не должно ронять экран: пространство открывается и
    // без него, а кнопка просто покажет «подписаться».
    const watching = await spaceWatchStatus(space.id, fetch, headers).catch(() => ({
      isWatching: false
    }));
    return { space, pages, watching };
  } catch (failure) {
    if (failure instanceof ApiError) {
      // Код отказа доходит до экрана: он и есть ключ перевода, а текст с
      // сервера показывать нельзя — он на одном языке из двенадцати.
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
