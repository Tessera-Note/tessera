import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listGroups } from '$lib/features/group/services/groups';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request, url }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;
  // Искомое живёт в адресе, а не в состоянии экрана: перечень постраничный, и
  // «показать ещё» после перезагрузки обязано продолжать тот же отбор.
  const q = url.searchParams.get('q')?.trim() || undefined;

  try {
    const found = await listGroups({ q }, fetch, headers);
    return { groups: found.items, nextCursor: found.meta.nextCursor, q: q ?? '' };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
