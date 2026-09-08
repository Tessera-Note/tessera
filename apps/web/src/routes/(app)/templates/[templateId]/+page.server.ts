import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { templateInfo } from '$lib/features/template/services/templates';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request, parent }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const template = await templateInfo(params.templateId, fetch, headers);
    // Пространства уже загружены слоем приложения: второй запрос за тем же
    // списком был бы лишним.
    const { spaces, session } = await parent();
    return { template, spaces, session };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
