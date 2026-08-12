import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { auditRetention, listAudit } from '$lib/features/audit/services/audit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  // Отбор живёт в адресе: так его видно в истории браузера и можно прислать
  // ссылкой, а перезагрузка не сбрасывает выбранное.
  const filter = {
    event: url.searchParams.get('event') ?? undefined,
    spaceId: url.searchParams.get('spaceId') ?? undefined
  };

  try {
    const [page, retention] = await Promise.all([
      listAudit(filter, fetch, headers),
      // Срок хранения правит только владелец, и сервер это проверяет. Отказ
      // здесь означает, что раздел человеку не полагается — журнал при этом
      // показывается.
      auditRetention(fetch, headers).catch(() => null)
    ]);
    return { page, retention, filter };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
