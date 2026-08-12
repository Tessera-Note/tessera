import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { openShared } from '$lib/features/share/services/share';
import type { PageServerLoad } from './$types';

/**
 * Страница по публичной ссылке.
 *
 * Вход не проверяется: ссылка и заводится ради тех, у кого учётной записи нет.
 * Правами служит сам ключ, а отозвана ли ссылка и жива ли страница, решает
 * сервер — здесь его отказ просто показывается человеку.
 */
export const load: PageServerLoad = async ({ params, url, fetch }) => {
  // Подстраница передаётся в адресе: одна ссылка открывает ветку целиком, и
  // переход внутри неё не должен требовать новой ссылки.
  const inner = url.searchParams.get('p') ?? undefined;

  try {
    return { key: params.key, page: await openShared(params.key, inner, fetch) };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
