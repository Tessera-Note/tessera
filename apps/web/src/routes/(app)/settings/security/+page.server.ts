import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listSessions } from '$lib/features/auth/services/sessions';
import { mfaStatus } from '$lib/features/mfa/services/mfa';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const [status, sessions] = await Promise.all([
      mfaStatus(fetch, headers),
      listSessions(fetch, headers)
    ]);
    return { status, sessions };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
