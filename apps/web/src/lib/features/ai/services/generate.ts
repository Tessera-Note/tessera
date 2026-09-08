/**
 * Переписывание выделенного текста моделью.
 *
 * Отдельно от разговора (`chat.ts`): там ход беседы с историей и инструментами,
 * здесь одна правка одного куска. Маршруты тоже разные, и общего у них только
 * склейка кусков потока.
 */

import { apiBase } from '$lib/api/base';
import { ApiError } from '$lib/api/client';
import { readData } from '$lib/features/ai/services/frames';
import { locale } from '$lib/stores/i18n.svelte';

/**
 * Действия над текстом. Значения понимает сервер, подписи видит человек.
 *
 * Перечень тот же, что в v1 и в `services/ai.py`: расхождение означало бы, что
 * кнопка шлёт действие, которого сервер не знает, и ответ приходит общим.
 */
export const AI_ACTIONS = [
  { value: 'improve_writing', label: 'Improve writing' },
  { value: 'fix_spelling_grammar', label: 'Fix spelling & grammar' },
  { value: 'make_shorter', label: 'Make shorter' },
  { value: 'make_longer', label: 'Make longer' },
  { value: 'simplify', label: 'Simplify language' },
  { value: 'summarize', label: 'Summarize' },
  { value: 'explain', label: 'Explain' },
  { value: 'continue_writing', label: 'Continue writing' },
  { value: 'translate', label: 'Translate' }
] as const;

type GenerateValues = { content: string; action?: string; prompt?: string };

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

/**
 * Переписать текст потоком.
 *
 * Потоком, а не одним ответом: правка длинного куска занимает секунды, и
 * молчание всё это время читается как поломка. Отказ приходит кадром —
 * заголовки к тому времени уже отправлены, и обычным отказом его не выразить.
 */
export async function* generateStream(
  values: GenerateValues,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const response = await fetch(`${apiBase()}/api/ai/generate/stream`, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(withLocale(values))
  });

  if (!response.ok || !response.body) {
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
    if (frame?.error) throw new ApiError(500, frame.error, '', {});
    if (frame?.content) yield frame.content;
  }
}

function parse(payload: string): { content?: string; error?: string } | null {
  try {
    return JSON.parse(payload) as { content?: string; error?: string };
  } catch {
    // Испорченный кадр пропускается: обрыв правки хуже пропуска одного куска.
    return null;
  }
}
