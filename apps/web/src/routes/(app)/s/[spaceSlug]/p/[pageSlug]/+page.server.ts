import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listComments } from '$lib/features/page/services/comments';
import { breadcrumbs, pageInfo } from '$lib/features/page/services/pages';
import { listFavorites } from '$lib/features/page/services/favorites';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request, parent }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Сервер принимает и короткое имя, и идентификатор: в адресе браузера
    // стоит первое, во внутренних переходах бывает второе.
    const page = await pageInfo(params.pageSlug, fetch, headers);
    // Три запроса разом, а не по очереди: они независимы, и последовательные
    // ждали бы друг друга без причины.
    const [crumbs, comments, favorites] = await Promise.all([
      breadcrumbs(page.id, fetch, headers),
      listComments(page.id, fetch, headers),
      listFavorites(fetch, headers)
    ]);
    // Пространство берётся из слоя приложения: оно уже загружено там, и
    // второй запрос за тем же списком был бы лишним.
    const { spaces } = await parent();
    return {
      page,
      crumbs,
      comments,
      space: spaces.find((one) => one.slug === params.spaceSlug),
      favorite: favorites.some((one) => one.pageId === page.id)
    };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
