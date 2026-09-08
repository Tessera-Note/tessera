import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { workspaceSettings } from '$lib/features/workspace/services/settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    return { settings: await workspaceSettings(fetch, headers) };
  } catch (failure) {
    if (failure instanceof ApiError) {
      // Отказ доступа означает, что раздел человеку не полагается: экран
      // показывает отказ целиком, а не пустую форму, которая ничего не сохранит.
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
