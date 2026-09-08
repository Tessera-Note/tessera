/**
 * Показ тела комментария.
 *
 * Разбор проверяется отдельно (`rich-text.test.ts`), здесь — разметка: что
 * начертания дошли до тегов, упоминание страницы стало ссылкой, а упоминание
 * человека — нет.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mentionTarget = vi.fn();
const pageOnce = vi.fn();

vi.mock('$lib/features/user/services/mentions', () => ({
  mentionTarget: (...args: unknown[]) => mentionTarget(...args)
}));
vi.mock('$lib/features/page/services/page-cache', () => ({
  pageOnce: (...args: unknown[]) => pageOnce(...args)
}));

const { default: RichText } = await import('./RichText.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(content: unknown): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(RichText, { target: host, props: { content } }) as Record<string, unknown>;
  flushSync();
  return host;
}

beforeEach(() => {
  // По умолчанию сеть молчит: разметка проверяется на замороженных подписях,
  // а разрешение — своими проверками ниже.
  mentionTarget.mockReset();
  pageOnce.mockReset();
  mentionTarget.mockRejectedValue(new Error('сеть'));
  pageOnce.mockRejectedValue(new Error('сеть'));
});

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });

describe('RichText', () => {
  it('показывает текст абзаца', () => {
    const box = render(doc({ type: 'paragraph', content: [text('простой текст')] }));
    expect(box.textContent).toContain('простой текст');
    expect(box.querySelector('p')).not.toBeNull();
  });

  it('доводит начертания до разметки', () => {
    const box = render(
      doc({
        type: 'paragraph',
        content: [text('жирный', [{ type: 'bold' }]), text('косой', [{ type: 'italic' }])]
      })
    );
    expect(box.querySelector('.font-semibold')?.textContent).toBe('жирный');
    expect(box.querySelector('.italic')?.textContent).toBe('косой');
  });

  it('ссылка становится ссылкой', () => {
    const box = render(
      doc({
        type: 'paragraph',
        content: [text('сюда', [{ type: 'link', attrs: { href: 'https://example.com' } }])]
      })
    );
    const link = box.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
  });

  it('упоминание страницы ведёт на страницу, упоминание человека никуда не ведёт', () => {
    // Разница осмысленная: у человека внутри вики своего экрана нет, и ссылка
    // вела бы в никуда.
    const box = render(
      doc({
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { label: 'План', entityType: 'page', slugId: 's1' } },
          { type: 'mention', attrs: { label: 'Пётр', entityType: 'user', entityId: 'u1' } }
        ]
      })
    );

    const links = [...box.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/p/s1');
    expect(box.textContent).toContain('@Пётр');
  });

  it('цитата и блок кода получают свою разметку', () => {
    const box = render(
      doc(
        { type: 'blockquote', content: [{ type: 'paragraph', content: [text('цитата')] }] },
        { type: 'codeBlock', content: [text('код')] }
      )
    );
    expect(box.querySelector('blockquote')?.textContent).toContain('цитата');
    expect(box.querySelector('pre')?.textContent).toContain('код');
  });

  it('пустое тело не рисует ни одного абзаца', () => {
    const box = render(doc({ type: 'paragraph' }));
    expect(box.querySelectorAll('p')).toHaveLength(0);
  });
});

describe('RichText, разрешение упоминаний', () => {
  /** Дать разрешению дойти до показа: ответ приходит обещанием. */
  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
  }

  it('показывает нынешнее имя, а не замороженное', async () => {
    // Тот же показ, что в теле страницы. Иначе имя удалённого уходило бы со
    // страницы и оставалось в обсуждении под ней.
    mentionTarget.mockResolvedValue({
      id: 'u1',
      name: 'Новое имя',
      deactivated: false
    });

    const box = render(
      doc({
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { label: 'Прежнее имя', entityType: 'user', entityId: 'u1' } }
        ]
      })
    );
    await settle();

    expect(box.textContent).toContain('Новое имя');
    expect(box.textContent).not.toContain('Прежнее имя');
  });

  it('удалённого показывает обезличенно', async () => {
    mentionTarget.mockResolvedValue(null);

    const box = render(
      doc({
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { label: 'Ушедший', entityType: 'user', entityId: 'u1' } }
        ]
      })
    );
    await settle();

    expect(box.textContent).toContain('Deleted user');
    expect(box.textContent).not.toContain('Ушедший');
  });
});
