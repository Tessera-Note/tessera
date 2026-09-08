/**
 * Остановка хода разговора.
 *
 * Проверяется одно: сказанное до остановки остаётся на экране. Человек читает
 * ответ и жмёт «стоп» потому, что прочитанного хватило, — стереть прочитанное
 * значит наказать за нажатие. Так же в v1 (`ee/ai-chat/hooks/use-chat-stream.ts`).
 *
 * Проверкой, а не осмотром: на поднятом развёртывании ответ приходит за
 * секунды, и попасть нажатием в середину потока рукой не выходит.
 */

import { flushSync, mount, unmount, tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatPage from '../../../routes/(app)/ai/[[chatId]]/+page.svelte';
import * as chat from './services/chat';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

/** Ход, который отдаёт кусок ответа и дальше ждёт остановки. */
function endlessTurn(piece: string) {
  return async function* (_values: unknown, signal?: AbortSignal) {
    yield { type: 'content', content: piece } as chat.Frame;
    await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  };
}

function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(ChatPage, {
    target: host,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props: { data: { chat: null } as any }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function answers(box: HTMLElement): string[] {
  return [...box.querySelectorAll('[data-role="assistant"] .chat-answer')].map((one) =>
    (one.textContent ?? '').trim()
  );
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
  vi.restoreAllMocks();
});

describe('экран разговора', () => {
  it('остановка сохраняет сказанное', async () => {
    // Разговор заводится до отправки: адрес нужен с первой секунды хода.
    // Здесь он не проверяется, но без подмены обращение ушло бы на сервер.
    vi.spyOn(chat, 'createChat').mockResolvedValue({
      id: 'c1',
      title: null,
      createdAt: '',
      updatedAt: ''
    } as never);
    vi.spyOn(chat, 'sendMessage').mockImplementation(
      endlessTurn('Завтра тепло.') as typeof chat.sendMessage
    );

    const box = render();
    const area = box.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'погода';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    box.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    // Ходов ожидания на два больше прежнего: заведение разговора и переход по
    // его адресу случаются до первого кадра ответа.
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    await tick();
    flushSync();

    expect(answers(box)).toEqual(['Завтра тепло.']);

    const stop = [...box.querySelectorAll('form button')].find(
      (one) => (one as HTMLButtonElement).type === 'button'
    ) as HTMLButtonElement;
    stop.click();
    await tick();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    // Реплика осталась, и она одна: остановленный ход не задваивается.
    expect(answers(box)).toEqual(['Завтра тепло.']);
  });
});
