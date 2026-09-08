/**
 * Ответ по содержимому вики.
 *
 * Проверяется разбор потока: источники приходят первым кадром, текст кусками,
 * отказ — своим кадром. Порядок задан сервером и важен: человек видит, на что
 * опирается ответ, ещё до того, как тот дописан.
 *
 * В окне (`.dom.test.ts`), потому что адрес обращения читает `$app/environment`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { askWiki } from './answers';
import { ApiError } from '$lib/api/client';

/** Ответ потоком из перечисленных кадров. */
function streamed(...payloads: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const one of payloads) controller.enqueue(encoder.encode(`data: ${one}\n`));
      controller.close();
    }
  });
  return new Response(body, { status: 200 });
}

async function collect(query = 'регламент') {
  const frames = [];
  for await (const frame of askWiki(query)) frames.push(frame);
  return frames;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('askWiki', () => {
  it('отдаёт источники, затем текст', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          streamed(
            '{"sources":[{"pageId":"1","title":"Регламент","slugId":"aaa","spaceSlug":"general","excerpt":null}]}',
            '{"content":"Ответ "}',
            '{"content":"целиком."}'
          )
        )
    );

    expect(await collect()).toEqual([
      {
        sources: [
          {
            pageId: '1',
            title: 'Регламент',
            slugId: 'aaa',
            spaceSlug: 'general',
            excerpt: null
          }
        ]
      },
      { content: 'Ответ ' },
      { content: 'целиком.' }
    ]);
  });

  it('несёт язык интерфейса в теле запроса', async () => {
    // Иначе на русский вопрос приходит английский ответ: локаль в учётной
    // записи пуста до первого захода в настройки.
    const fetcher = vi.fn().mockResolvedValue(streamed('{"content":"ок"}'));
    vi.stubGlobal('fetch', fetcher);

    await collect();

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toHaveProperty('locale');
  });

  it('отказ до первого кадра приходит обычным отказом', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'error.ai.disabled' }), { status: 400 })
        )
    );

    await expect(collect()).rejects.toBeInstanceOf(ApiError);
  });

  it('испорченный кадр пропускается, а не рвёт ответ', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamed('{битый', '{"content":"дальше"}')));

    expect(await collect()).toEqual([{ content: 'дальше' }]);
  });
});
