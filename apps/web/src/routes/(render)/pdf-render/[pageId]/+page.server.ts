import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { renderData } from '$lib/features/page/services/pdf';
import type { PageServerLoad } from './$types';

/**
 * Страница, которую печатает Gotenberg.
 *
 * Вход не проверяется: у безголового браузера его нет. Учётными данными служит
 * токен из адреса, выписанный на одно задание; состав документа берёт сервер из
 * этого задания, а не из адреса — здесь передаётся только токен.
 */
export const load: PageServerLoad = async ({ url, fetch }) => {
  const token = url.searchParams.get('token');
  if (!token) {
    error(401, {
      message: 'Render token required',
      code: 'error.pdf_export.invalid_or_expired_render_token'
    });
  }

  try {
    const answer = await renderData(token, fetch);
    // Сколько страниц ветви было видно заказчику. Больше, чем вошло, — лист
    // называет неполноту сам: файл уходит дальше без экрана, где её показали.
    return { pages: answer.pages, totalPages: answer.totalPages ?? answer.pages.length };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
