import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listNotifications, type Tab } from '$lib/features/notification/services/notifications';
import type { PageServerLoad } from './$types';

const TABS: Tab[] = ['all', 'direct', 'updates'];

export const load: PageServerLoad = async ({ url, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  // Вкладка живёт в адресе, а не в памяти страницы: так её видно в истории
  // браузера и можно прислать ссылкой.
  const asked = url.searchParams.get('tab') as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : 'all';

  try {
    return { tab, notifications: await listNotifications(tab, fetch, headers) };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
