import { error } from '@sveltejs/kit';
import { ApiError, get } from '$lib/api/client';
import type { PageServerLoad } from './$types';

type WorkspaceInfo = {
  id: string;
  name: string | null;
  hostname: string | null;
  memberCount: number | null;
};

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    return {
      workspace: await get<WorkspaceInfo>('/api/workspace/info', { fetcher: fetch, headers })
    };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
