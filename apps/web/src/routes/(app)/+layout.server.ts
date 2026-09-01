import { redirect } from '@sveltejs/kit';
import { listChats } from '$lib/features/ai/services/chat';
import { unreadCount } from '$lib/features/notification/services/notifications';
import { listSpaces } from '$lib/features/space/services/spaces';
import type { LayoutServerLoad } from './$types';

/**
 * Общая часть рабочих экранов.
 *
 * Проверка входа здесь, а не на каждом маршруте: пропустить её в одном месте
 * из сорока достаточно, чтобы экран открылся невошедшему.
 */
export const load: LayoutServerLoad = async ({ locals, fetch, request, url }) => {
  if (!locals.session) {
    // Куда человек шёл, запоминается: после входа он возвращается туда, а не
    // на общий экран.
    redirect(302, `/login?redirect=${encodeURIComponent(url.pathname)}`);
  }

  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;
  // Разговоры нужны только на своих экранах: в v1 боковая панель там показывает
  // их вместо пространств, и грузить их на каждом экране незачем.
  const wantsChats = url.pathname.startsWith('/ai');

  const [spaces, unread, chats] = await Promise.all([
    listSpaces(fetch, headers),
    // Значок непрочитанного не повод не показать экран: отказ счётчика гасит
    // только сам значок.
    unreadCount(fetch, headers).catch(() => ({ count: 0 })),
    wantsChats
      ? listChats(undefined, fetch, headers).catch(() => ({ items: [], nextCursor: null }))
      : Promise.resolve({ items: [], nextCursor: null })
  ]);
  return { session: locals.session, spaces, unread: unread.count, chats };
};
