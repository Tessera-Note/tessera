import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listVerifications } from '$lib/features/verification/services/verifications';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;
  // Отбор живёт в адресе: тогда отобранный список можно передать ссылкой, а
  // возврат на экран не сбрасывает выбор.
  const status = url.searchParams.get('status') ?? undefined;

  try {
    return { status, rows: await listVerifications({ status }, fetch, headers) };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
