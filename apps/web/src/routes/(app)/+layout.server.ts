import { redirect } from '@sveltejs/kit';
import { listSpaces } from '$lib/features/space/services/spaces';
import type { LayoutServerLoad } from './$types';

/**
 * Общая часть рабочих экранов.
 *
 * Проверка входа здесь, а не на каждом маршруте: пропустить её в одном месте
 * из сорока достаточно, чтобы экран открылся невошедшему.
 */
export const load: LayoutServerLoad = async ({ locals, fetch, request, url }) => {
  if (!locals.session) {
    // Куда человек шёл, запоминается: после входа он возвращается туда, а не
    // на общий экран.
    redirect(302, `/login?redirect=${encodeURIComponent(url.pathname)}`);
  }

  const cookie = request.headers.get('cookie');
  const spaces = await listSpaces(fetch, cookie ? { cookie } : undefined);
  return { session: locals.session, spaces };
};
