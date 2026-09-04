/**
 * Редактор диаграмм.
 *
 * Проверяется поведение при отказе сохранения. До правки окно закрывалось в
 * `finally` — то есть одинаково при успехе и при отказе: правка диаграммы
 * терялась молча, и человеку не говорилось ничего.
 *
 * Сам редактор живёт в рамке чужого сервиса; здесь проверяется только обмен
 * сообщениями с ним и то, что из него следует.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DrawioEditor from './DrawioEditor.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(DrawioEditor, {
    target: host,
    props: { xml: '', save: async () => {}, close: () => {}, ...props }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

/**
 * Сообщение из рамки редактора. Обмен идёт строками JSON.
 *
 * Источник обязателен: обработчик отбрасывает всё, что пришло не из своей
 * рамки, и это правильно — иначе любая страница в окне могла бы прислать
 * «сохрани вот это».
 */
function fromEditor(payload: Record<string, unknown>): void {
  const frame = host?.querySelector('iframe');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify(payload),
      source: frame?.contentWindow ?? undefined
    })
  );
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('DrawioEditor', () => {
  it('на успехе сохраняет и закрывает', async () => {
    const save = vi.fn(async () => {});
    const close = vi.fn();
    render({ save, close });

    fromEditor({ event: 'export', data: '<svg/>' });
    await settle();

    expect(save).toHaveBeenCalledWith('<svg/>');
    expect(close).toHaveBeenCalled();
  });

  it('на отказе не закрывается и говорит человеку', async () => {
    // Главная проверка. Закрытие при отказе означало бы потерянную диаграмму:
    // работа в рамке пропадает вместе с окном, а второй попытки нет.
    const save = vi.fn(async () => {
      throw new Error('вложение не легло');
    });
    const close = vi.fn();
    const box = render({ save, close });

    fromEditor({ event: 'export', data: '<svg/>' });
    await settle();

    expect(close).not.toHaveBeenCalled();
    expect(box.querySelector('[role="alert"]')?.textContent ?? '').not.toBe('');
  });

  it('выход из редактора закрывает окно', async () => {
    const close = vi.fn();
    render({ close });

    fromEditor({ event: 'exit' });
    await settle();

    expect(close).toHaveBeenCalled();
  });

  it('чужие сообщения окна не разбираются', async () => {
    // Не из своей рамки — не наше. Иначе любая страница в окне могла бы
    // прислать «сохрани вот это».
    const save = vi.fn(async () => {});
    render({ save });

    window.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ event: 'export', data: '<svg/>' }) })
    );
    await settle();

    expect(save).not.toHaveBeenCalled();
  });

  it('не-JSON из своей рамки не роняет разбор', async () => {
    const save = vi.fn(async () => {});
    const box = render({ save });

    const frame = box.querySelector('iframe');
    window.dispatchEvent(
      new MessageEvent('message', { data: 'не обмен', source: frame?.contentWindow ?? undefined })
    );
    await settle();

    expect(save).not.toHaveBeenCalled();
  });
});
