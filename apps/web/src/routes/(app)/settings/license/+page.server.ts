import { error } from '@sveltejs/kit';
import { ApiError, get, post } from '$lib/api/client';
import type { PageServerLoad } from './$types';

type WorkspaceInfo = {
  id: string;
  name: string | null;
  hostname: string | null;
  memberCount: number | null;
};

/**
 * Сведения о выпуске.
 *
 * `latestVersion` приходит от соседнего сервиса и бывает пустым: развёртывание
 * без него — обычный случай, и экран на этом краснеть не должен.
 */
type Version = {
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string;
};

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const [workspace, version] = await Promise.all([
      get<WorkspaceInfo>('/api/workspace/info', { fetcher: fetch, headers }),
      // Отказ здесь экран не закрывает: своя версия важна, но не настолько,
      // чтобы из-за недоступного соседа не открылась страница лицензии.
      post<Version>('/api/version', {}, { fetcher: fetch, headers }).catch(() => null)
    ]);
    return { workspace, version };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
