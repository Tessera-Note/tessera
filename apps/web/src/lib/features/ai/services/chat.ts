import { apiBase } from '$lib/api/base';
import { ApiError, post } from '$lib/api/client';
import { readFrames, type Frame } from '$lib/features/ai/services/frames';
import { locale } from '$lib/stores/i18n.svelte';

export type { Frame };

export type Chat = {
  id: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ChatMessage = {
  id: string;
  role: string;
  content: string;
  toolCalls: unknown;
  metadata: unknown;
  createdAt: string | null;
};

export type ChatBody = Chat & { messages: ChatMessage[] };

/**
 * Язык интерфейса добавляется здесь, а не вызывающим.
 *
 * Локаль в учётной записи пуста до первого захода в настройки, а интерфейс
 * всё это время показан на языке браузера, и сервер отвечал по-английски на
 * русский вопрос. Место выбрано так, чтобы ни одно место вызова не могло
 * забыть язык: забытый язык виден только по языку ответа.
 */
function withLocale<T extends object>(values: T): T & { locale: string } {
  return { ...values, locale: locale.current };
}

export function listChats(
  cursor?: string,
  fetcher?: typeof fetch,
  headers?: Record<string, string>
) {
  return post<{ items: Chat[]; nextCursor: string | null }>(
    '/api/ai/chats',
    { cursor },
    { fetcher, headers }
  );
}

/**
 * Поиск по разговорам.
 *
 * Отдельным обращением, а не отбором на клиенте: список подгружается страницами,
 * и отбор по загруженному пропускал бы всё, что ещё не пришло.
 */
export function searchChats(query: string, fetcher?: typeof fetch) {
  return post<Chat[]>('/api/ai/chats/search', { query }, { fetcher });
}

export function chatInfo(chatId: string, fetcher?: typeof fetch, headers?: Record<string, string>) {
  return post<ChatBody>('/api/ai/chats/info', { chatId }, { fetcher, headers });
}

export function renameChat(chatId: string, title: string, fetcher?: typeof fetch) {
  return post<Chat>('/api/ai/chats/update', { chatId, title }, { fetcher });
}

export function deleteChat(chatId: string, fetcher?: typeof fetch) {
  return post<{ status: string }>('/api/ai/chats/delete', { chatId }, { fetcher });
}

/**
 * Решение по плану необратимых действий.
 *
 * Пока решения нет, шаги не выполнены: сервер их сохранил и ждёт. Без этого
 * вызова такой план висит вечно, а разговор выглядит незаконченным.
 *
 * Второе решение по тому же плану сервер отклоняет: захват записи одним
 * условным обновлением, чтобы два подтверждения не выполнили шаги дважды.
 */
export function resolvePlan(
  messageId: string,
  decision: 'confirm' | 'reject',
  fetcher?: typeof fetch
) {
  return post<{ status: string; results: { tool: string; ok: boolean; error?: string }[] }>(
    '/api/ai/chats/resolve-plan',
    { messageId, decision },
    { fetcher }
  );
}

/**
 * Ход разговора.
 *
 * Потоком, а не одним ответом: ход с инструментами длится десятки секунд, и
 * молчание всё это время читается как поломка. Отказ приходит кадром — заголовки
 * к тому времени уже отправлены, и обычным отказом его не выразить.
 */
export async function* sendMessage(
  values: { message: string; chatId?: string; mentionedPageIds?: string[] },
  signal?: AbortSignal
): AsyncGenerator<Frame> {
  const response = await fetch(`${apiBase()}/api/ai/chats/send`, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(withLocale(values))
  });

  if (!response.ok || !response.body) {
    // До первого кадра отказ обычный: поток ещё не начался.
    const body = await response.text();
    let code = 'error.common.unknown';
    let message = '';
    try {
      const parsed = JSON.parse(body) as { code?: string; message?: string };
      code = parsed.code ?? code;
      message = parsed.message ?? '';
    } catch {
      // Тело не разобралось: отвечает не наш сервер, а что-то на его месте.
    }
    throw new ApiError(response.status, code, message, {});
  }

  // Разбор кадров живёт отдельно и проверяется отдельно: куски приходят как
  // придётся, и склейка хвоста — то место, где ответ терялся бы молча.
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  async function* chunks(): AsyncGenerator<string> {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }

  yield* readFrames(chunks());
}
