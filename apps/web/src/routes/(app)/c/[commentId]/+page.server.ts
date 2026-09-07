import { error, redirect } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { commentInfo } from '$lib/features/page/services/comments';
import { pageInfo } from '$lib/features/page/services/pages';
import type { PageServerLoad } from './$types';

/**
 * Ссылка на отдельную реплику.
 *
 * Своего экрана у комментария нет и быть не должно: реплику читают вместе со
 * страницей, которую она обсуждает. Здесь по идентификатору узнаётся страница,
 * и человек уходит на неё с открытым обсуждением. Право проверяет сервер по
 * той же странице, поэтому закрытая реплика отвечает отказом, а не выдаёт
 * название страницы.
 */
export const load: PageServerLoad = async ({ params, fetch, request, parent }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  let target: { slug: string; pageSlug: string };
  try {
    const comment = await commentInfo(params.commentId, fetch, headers);
    if (!comment.pageId) error(404, { message: 'error.comment.comment_not_found' });

    const page = await pageInfo(comment.pageId, fetch, headers);
    const { spaces } = await parent();
    const space = spaces.find((one) => one.id === page.spaceId);
    if (!space) error(404, { message: 'error.page.page_not_found' });

    target = { slug: space.slug, pageSlug: page.slugId };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }

  // Переход снаружи `try`: он выражен исключением, и разбор отказов принял бы
  // его за отказ обращения к серверу.
  redirect(307, `/s/${target.slug}/p/${target.pageSlug}?comment=${params.commentId}`);
};
