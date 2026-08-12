import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { pageInfo } from '$lib/features/page/services/pages';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Сервер принимает и короткое имя, и идентификатор: в адресе браузера
    // стоит первое, во внутренних переходах бывает второе.
    const page = await pageInfo(params.pageSlug, fetch, headers);
    return { page };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
