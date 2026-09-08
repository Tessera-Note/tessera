import { error, redirect } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { pageInfo } from '$lib/features/page/services/pages';
import { listSpaces } from '$lib/features/space/services/spaces';
import type { PageServerLoad } from './$types';

/**
 * Короткий адрес страницы.
 *
 * Такие ссылки раздаются в письмах и упоминаниях: там короткого имени
 * пространства нет, а страница переезжает между пространствами. Поэтому адрес
 * достраивается здесь, а не на стороне того, кто ссылку составил.
 */
export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  let target: string;
  try {
    const page = await pageInfo(params.pageSlug, fetch, headers);
    const spaces = await listSpaces(fetch, headers);
    const space = spaces.find((one) => one.id === page.spaceId);
    if (!space) {
      // Страница есть, а пространства в списке нет: доступ к нему потерян.
      error(404, { message: 'Page not found', code: 'error.page.page_not_found' });
    }
    target = `/s/${space.slug}/p/${page.slugId}`;
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }

  // Перенаправление вне `try`: SvelteKit выражает его исключением, и внутри
  // оно было бы поймано разбором отказа как ошибка.
  redirect(307, target);
};
