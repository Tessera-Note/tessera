/**
 * Язык интерфейса уходит с каждым обращением к модели.
 *
 * Заведена после живого дефекта: локаль в учётной записи пуста до первого
 * захода в настройки, интерфейс всё это время показан на языке браузера, и на
 * русский вопрос приходил английский ответ. Забытый язык ничем, кроме языка
 * ответа, не проявляется — отказа нет, разметка не меняется.
 *
 * В окне (`.dom.test.ts`), потому что адрес обращения читает `$app/environment`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from './chat';
import { generateStream } from './generate';
import { locale } from '$lib/stores/i18n.svelte';

function bodyOf(call: unknown): Record<string, unknown> {
  const [, init] = call as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** Ответ потоком из одного кадра: разбор кадров здесь не проверяется. */
function streamed(payload: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${payload}\n`));
      controller.close();
    }
  });
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('обращения к модели', () => {
  it('ход разговора несёт язык интерфейса', async () => {
    await locale.set('uk-UA');
    const fetcher = vi.fn().mockResolvedValue(streamed('{"type":"done","messageId":"1"}'));
    vi.stubGlobal('fetch', fetcher);

    for await (const _frame of sendMessage({ message: 'погода в ирпине' })) {
      // Кадры здесь не важны: проверяется тело запроса.
    }

    expect(bodyOf(fetcher.mock.calls[0])).toMatchObject({
      message: 'погода в ирпине',
      locale: 'uk-UA'
    });
  });

  it('переписывание текста несёт язык интерфейса', async () => {
    await locale.set('ru-RU');
    const fetcher = vi.fn().mockResolvedValue(streamed('{"content":"готово"}'));
    vi.stubGlobal('fetch', fetcher);

    for await (const _piece of generateStream({ content: 'текст', action: 'make_shorter' })) {
      // То же: важно тело запроса, а не куски ответа.
    }

    expect(bodyOf(fetcher.mock.calls[0])).toMatchObject({
      content: 'текст',
      action: 'make_shorter',
      locale: 'ru-RU'
    });
  });
});
