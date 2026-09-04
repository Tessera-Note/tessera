import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { chatInfo } from '$lib/features/ai/services/chat';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    // Сам разговор — только когда он выбран. Пустой адрес `/ai` это новый
    // разговор: он заводится первой репликой. Список разговоров грузит слой
    // приложения, он же его и показывает.
    const chat = params.chatId ? await chatInfo(params.chatId, fetch, headers) : null;
    return { chat };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};

/**
 * Разговор рисуется в браузере.
 *
 * Ответ модели показывается разметкой, а очиститель разметки работает по DOM,
 * которого на сервере нет. Отрисовка на сервере падала на этом отказом 500.
 *
 * Потери здесь нет: разговор идёт потоком SSE, отменяется кнопкой и без
 * сценариев не работает вовсе — отдавать его готовой страницей нечему.
 * Загрузчик выше остаётся серверным, реплики по-прежнему приходят с сервера.
 */
export const ssr = false;
