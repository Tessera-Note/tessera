/**
 * Ответ по содержимому вики.
 *
 * Отдельно от поиска: поиск отдаёт перечень страниц, а здесь модель читает
 * найденное и отвечает словами, указывая, на что опиралась. В v1 это режим
 * «Ask» в том же окне поиска (`features/search/components/search-spotlight.tsx`).
 *
 * Первым кадром приходят источники, потом текст. Порядок задан сервером и
 * важен: человек видит, на что опирается ответ, ещё до того, как тот дописан,
 * и может бросить чтение, если материал не тот.
 */

import { apiBase } from '$lib/api/base';
import { ApiError } from '$lib/api/client';
import { readData } from '$lib/features/ai/services/frames';
import { locale } from '$lib/stores/i18n.svelte';

/** Страница, на которую опирается ответ. */
export type AnswerSource = {
  pageId: string;
  title: string | null;
  slugId: string;
  spaceSlug: string;
  excerpt: string | null;
};

/** Кадр потока. Виды перечислены полностью, как их шлёт сервер. */
export type AnswerFrame = { sources: AnswerSource[] } | { content: string } | { error: string };

export async function* askWiki(
  query: string,
  spaceId?: string | null,
  signal?: AbortSignal
): AsyncGenerator<AnswerFrame> {
  const response = await fetch(`${apiBase()}/api/ai/answers`, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: { 'content-type': 'application/json' },
    // Язык интерфейса добавляется здесь, а не вызывающим: локаль в учётной
    // записи пуста до первого захода в настройки, и ответ приходил
    // по-английски на русский вопрос.
    body: JSON.stringify({ query, spaceId: spaceId || undefined, locale: locale.current })
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

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  async function* chunks(): AsyncGenerator<string> {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }

  for await (const payload of readData(chunks())) {
    const frame = parse(payload);
    if (frame) yield frame;
  }
}

function parse(payload: string): AnswerFrame | null {
  try {
    return JSON.parse(payload) as AnswerFrame;
  } catch {
    // Испорченный кадр пропускается: обрыв ответа хуже пропуска одного куска.
    return null;
  }
}
