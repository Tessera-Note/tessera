/**
 * Разбор потока ответа.
 *
 * Отдельным файлом и без единого импорта: разбор проверяется сам по себе, а
 * `chat.ts` тянет адрес API и с ним модули SvelteKit.
 */

/**
 * Кадр потока ответа. Виды перечислены полностью, как их шлёт сервер.
 *
 * Перечислены, а не оставлены открытыми: открытый вид ломает разбор по полю
 * `type`, и обращение к содержимому кадра перестаёт проверяться вовсе.
 */
export type Frame =
  | { type: 'chat_created'; chat: { id: string; title: string | null } }
  | { type: 'content'; content: string }
  | { type: 'tool_call'; name: string; arguments: unknown }
  | { type: 'tool_result'; name: string; isError: boolean }
  | { type: 'plan'; messageId: string; steps: { tool: string; args: unknown }[] }
  | { type: 'done'; messageId: string }
  | { type: 'error'; error: string; message?: string };

/** Признак конца потока. Значение то же, что у сервера. */
export const DONE = '[DONE]';

/**
 * Кадры из потока кусков текста.
 *
 * Куски приходят как придётся: строка кадра рвётся посередине, в одном куске
 * их бывает несколько. Поэтому хвост копится до следующего куска, а не
 * разбирается сразу — иначе половина ответа теряется молча.
 *
 * Испорченный кадр пропускается: обрыв разговора хуже пропуска одного куска.
 */
export async function* readFrames(chunks: AsyncIterable<string>): AsyncGenerator<Frame> {
  for await (const payload of readData(chunks)) {
    const frame = parse(payload);
    if (frame) yield frame as Frame;
  }
}

/**
 * Содержимое кадров, ещё не разобранное.
 *
 * Отдельно от `readFrames`, потому что поток переписывания текста
 * (`/api/ai/generate/stream`) шлёт кадры другого вида — `{content}` и
 * `{error}`, без поля `type`. Склейка кусков у них общая, и вторая её копия
 * разошлась бы с этой на первом же исправлении.
 */
export async function* readData(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let rest = '';

  for await (const chunk of chunks) {
    rest += chunk;
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const payload = payloadOf(line);
      if (payload) yield payload;
    }
  }

  // Поток мог закончиться без перевода строки: последний кадр иначе пропал бы.
  const last = payloadOf(rest);
  if (last) yield last;
}

function payloadOf(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === DONE) return null;
  return payload;
}

function parse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
