import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { chatInfo, listChats } from '$lib/features/ai/services/chat';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Список нужен всегда, сам разговор — только когда он выбран. Пустой
    // адрес `/ai` это новый разговор: он заводится первой репликой.
    const [chats, chat] = await Promise.all([
      listChats(undefined, fetch, headers),
      params.chatId ? chatInfo(params.chatId, fetch, headers) : Promise.resolve(null)
    ]);
    return { chats: chats.items, chat };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
