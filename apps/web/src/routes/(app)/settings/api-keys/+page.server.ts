import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listApiKeys } from '$lib/features/api-key/services/api-keys';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, fetch, request, parent }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  const { session } = await parent();
  const admin = session?.user.role === 'admin' || session?.user.role === 'owner';
  // Признак живёт в адресе: так его видно в истории браузера, и переключение
  // не теряется при перезагрузке. Не администратору он не предлагается вовсе.
  const all = admin && url.searchParams.get('all') === '1';

  try {
    return { keys: await listApiKeys(all, fetch, headers), admin, all };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
