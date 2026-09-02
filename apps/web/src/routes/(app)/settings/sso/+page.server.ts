import { error, redirect } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listProviders } from '$lib/features/sso/services/providers';
import { listScimTokens } from '$lib/features/scim/services/tokens';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request, parent }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  const { session } = await parent();
  const role = session?.user.role;
  // Экран целиком административный: и провайдеры входа, и токены каталога
  // открывают доступ в пространство. Участнику показывать нечего.
  if (role !== 'admin' && role !== 'owner') redirect(302, '/settings/account');

  try {
    const [providers, tokens] = await Promise.all([
      listProviders(fetch, headers),
      listScimTokens(fetch, headers)
    ]);
    return { providers: providers.items, tokens };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
