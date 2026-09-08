import type { LayoutServerLoad } from './$types';

/** Вход отдаётся всем маршрутам разом: спрашивать его на каждом — лишний запрос. */
export const load: LayoutServerLoad = async ({ locals }) => ({ session: locals.session });
