import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Корень ведёт домой вошедшему и на вход остальным. */
export const load: PageServerLoad = async ({ locals }) => {
  redirect(302, locals.session ? '/home' : '/login');
};
