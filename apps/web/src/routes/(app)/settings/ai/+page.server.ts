import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { aiSettings } from '$lib/features/ai/services/settings';
import { workspaceSettings } from '$lib/features/workspace/services/settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Выключатели возможностей живут в настройках пространства, а показывать
    // их надо здесь: человек ищет их там, где настраивает провайдера.
    const [settings, workspace] = await Promise.all([
      aiSettings(fetch, headers),
      workspaceSettings(fetch, headers)
    ]);
    return { settings, workspace };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
