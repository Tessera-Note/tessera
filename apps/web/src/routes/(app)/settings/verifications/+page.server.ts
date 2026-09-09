import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listVerifications } from '$lib/features/verification/services/verifications';
import { listMembers } from '$lib/features/workspace/services/members';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;
  // Отбор живёт в адресе: тогда отобранный список можно передать ссылкой, а
  // возврат на экран не сбрасывает выбор.
  const status = url.searchParams.get('status') ?? undefined;
  const spaceId = url.searchParams.get('spaceId') ?? undefined;
  const query = url.searchParams.get('q') ?? undefined;
  const verifierId = url.searchParams.get('verifierId') ?? undefined;
  // Вид проверки: повторная или утверждение документа. Отбор из v1.
  const type = url.searchParams.get('type') ?? undefined;

  try {
    const [page, members] = await Promise.all([
      listVerifications({ status, spaceId, query, verifierId, type }, fetch, headers),
      // Перечень подтверждающих виден администратору; участнику отбор по
      // человеку не показывается вовсе, и отказ перечня его не отменяет.
      listMembers(fetch, headers).catch(() => [])
    ]);
    return {
      status,
      spaceId,
      query,
      verifierId,
      type,
      rows: page.items,
      nextCursor: page.meta.nextCursor,
      members
    };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
