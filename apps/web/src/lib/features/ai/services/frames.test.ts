import { describe, expect, it } from 'vitest';
import { readFrames, type Frame } from '$lib/features/ai/services/frames';

/** Поток из перечисленных кусков, ровно как их отдаёт чтение тела ответа. */
async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) yield part;
}

async function collect(...parts: string[]): Promise<Frame[]> {
  const found: Frame[] = [];
  for await (const frame of readFrames(chunks(...parts))) found.push(frame);
  return found;
}

describe('кадры потока', () => {
  it('читает кадры из одного куска', async () => {
    const found = await collect('data: {"type":"content","content":"раз"}\n');
    expect(found).toEqual([{ type: 'content', content: 'раз' }]);
  });

  it('собирает кадр, разорванный между кусками', async () => {
    // Ради этого случая хвост и копится: кусок приходит как придётся, и
    // разбор строки целиком терял бы половину ответа молча.
    const found = await collect('data: {"type":"con', 'tent","content":"два"}\n');
    expect(found).toEqual([{ type: 'content', content: 'два' }]);
  });

  it('читает несколько кадров из одного куска', async () => {
    const found = await collect(
      'data: {"type":"content","content":"а"}\ndata: {"type":"content","content":"б"}\n'
    );
    expect(found.map((one) => (one.type === 'content' ? one.content : null))).toEqual(['а', 'б']);
  });

  it('отдаёт последний кадр без перевода строки в конце', async () => {
    const found = await collect('data: {"type":"done","messageId":"7"}');
    expect(found).toEqual([{ type: 'done', messageId: '7' }]);
  });

  it('пропускает признак конца и пустые строки', async () => {
    const found = await collect('\ndata: [DONE]\ndata: \n');
    expect(found).toEqual([]);
  });

  it('пропускает испорченный кадр, не обрывая остальные', async () => {
    const found = await collect('data: {сломано}\ndata: {"type":"content","content":"три"}\n');
    expect(found).toEqual([{ type: 'content', content: 'три' }]);
  });

  it('не принимает строки, которые кадрами не являются', async () => {
    // Поток несёт и служебные строки: `event:`, `id:`, комментарии.
    const found = await collect(': держим соединение\nevent: message\nid: 1\n');
    expect(found).toEqual([]);
  });
});
