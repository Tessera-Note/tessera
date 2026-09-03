import { redirect } from '@sveltejs/kit';
import { publicWorkspace } from '$lib/features/auth/services/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, fetch, request }) => {
  // Вошедшему форма входа не нужна: он попадает сюда по старой закладке.
  if (locals.session) redirect(302, '/home');

  const cookie = request.headers.get('cookie');
  try {
    // Провайдеры нужны самой форме: без них экран входа рисуется без единой
    // кнопки провайдера, и войти через него нечем.
    return { workspace: await publicWorkspace(fetch, cookie ? { cookie } : undefined) };
  } catch {
    // Отказ здесь не должен закрывать вход по паролю: он работает и без
    // сведений о пространстве.
    return { workspace: null };
  }
};
