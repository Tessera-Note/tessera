import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  // Вошедшему форма входа не нужна: он попадает сюда по старой закладке.
  if (locals.session) redirect(302, '/home');
  return {};
};
