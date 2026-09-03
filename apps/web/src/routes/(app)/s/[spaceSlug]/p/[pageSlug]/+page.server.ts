import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { backlinksOf } from '$lib/features/page/services/backlinks';
import { listComments } from '$lib/features/page/services/comments';
import { listFavorites } from '$lib/features/page/services/favorites';
import { listVersions } from '$lib/features/page/services/history';
import { labelsOfPage } from '$lib/features/page/services/labels';
import { permissionInfo } from '$lib/features/page/services/permissions';
import { verificationInfo } from '$lib/features/verification/services/page';
import { breadcrumbs, pageInfo, watchStatus } from '$lib/features/page/services/pages';
import { shareForPage } from '$lib/features/share/services/share';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request, parent }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Сервер принимает и короткое имя, и идентификатор: в адресе браузера
    // стоит первое, во внутренних переходах бывает второе.
    const page = await pageInfo(params.pageSlug, fetch, headers);

    // Всё разом, а не по очереди: запросы независимы, и последовательные
    // ждали бы друг друга без причины. Отказ бокового содержимого не должен
    // ронять саму страницу, поэтому каждый со своим запасным значением.
    const [
      crumbs,
      comments,
      favorites,
      versions,
      labels,
      backlinks,
      permission,
      share,
      verification,
      watching
    ] = await Promise.all([
      breadcrumbs(page.id, fetch, headers),
      listComments(page.id, fetch, headers),
      listFavorites(fetch, headers),
      listVersions(page.id, fetch, headers).catch(() => []),
      labelsOfPage(page.id, fetch, headers).catch(() => []),
      backlinksOf(page.id, fetch, headers).catch(() => []),
      permissionInfo(page.id, fetch, headers).catch(() => null),
      shareForPage(page.id, fetch, headers).catch(() => null),
      verificationInfo(page.id, fetch, headers).catch(() => null),
      watchStatus(page.id, fetch, headers).catch(() => ({ isWatching: false, isMuted: false }))
    ]);

    // Пространство берётся из слоя приложения: оно уже загружено там, и второй
    // запрос за тем же списком был бы лишним.
    const { spaces } = await parent();
    return {
      page,
      crumbs,
      comments,
      versions,
      labels,
      backlinks,
      permission,
      share,
      verification,
      watching,
      spaces,
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
