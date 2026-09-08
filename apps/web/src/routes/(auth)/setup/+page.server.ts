import { redirect } from '@sveltejs/kit';
import { setupRequired } from '$lib/features/auth/services/auth';
import type { PageServerLoad } from './$types';

/**
 * Экран первой настройки.
 *
 * Настроенный экземпляр сюда не пускает: маршрут срабатывает один раз, и
 * оставленная открытой форма создавала бы впечатление, что второе рабочее
 * пространство можно завести отсюда.
 */
export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const answer = await setupRequired(fetch, cookie ? { cookie } : undefined);
  if (!answer.setupRequired) redirect(302, '/login');
  return {};
};
