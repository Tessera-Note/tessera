import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listFavoriteTemplates } from '$lib/features/page/services/favorites';
import { listTemplates } from '$lib/features/template/services/templates';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;
  // Отбор живёт в адресе: он ушёл на сервер вместе с постраничной выдачей, и
  // без перезагрузки страницы сменить его нечем. Заодно отобранный перечень
  // можно передать ссылкой.
  const spaceId = url.searchParams.get('spaceId') ?? undefined;

  try {
    const [page, favorites] = await Promise.all([
      listTemplates({ spaceId }, fetch, headers),
      // Отметки не повод не показать перечень: отказ гасит только звёзды.
      listFavoriteTemplates(fetch, headers).catch(() => [])
    ]);
    return {
      spaceId,
      templates: page.items,
      nextCursor: page.meta.nextCursor,
      favorites
    };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
