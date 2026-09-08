/**
 * Лист для печати.
 *
 * Проверяется одно: признак готовности не появляется раньше, чем нарисованы
 * все страницы. Gotenberg снимает лист по этому признаку, а показ документа
 * собирает редактор уже в браузере — признак, поставленный сразу, уносил в PDF
 * запасной плоский текст вместо страницы.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/components/page/PageBody.svelte', async () => ({
  default: (await import('../../../test-stubs/ReadyProbe.svelte')).default
}));

const { default: PdfRenderPage } = await import('./[pageId]/+page.svelte');

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

function render(pages: { pageId: string; title: string; content: unknown }[]): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(PdfRenderPage, {
    target: host,
    props: { data: { pages } as never }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function ready(box: HTMLElement): boolean {
  return box.querySelector('[data-route="pdf-render"]')?.getAttribute('data-pdf-ready') === 'true';
}

const two = [
  { pageId: 'p1', title: 'Первая', content: null },
  { pageId: 'p2', title: 'Вторая', content: null }
];

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
  vi.useRealTimers();
});

/** Документ с заголовками: оглавление собирается по ним, а не по разметке. */
function heading(level: number, text: string) {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function contents(box: HTMLElement): string[] {
  return [...box.querySelectorAll('[data-component="PrintToc"] li')].map((one) =>
    (one.textContent ?? '').trim()
  );
}

describe('Оглавление на листе', () => {
  it('перечисляет разделы одной страницы', () => {
    const box = render([
      {
        pageId: 'p1',
        title: 'Отчёт',
        content: { type: 'doc', content: [heading(1, 'Итоги'), heading(2, 'Цифры')] }
      }
    ]);

    expect(contents(box)).toEqual(['Итоги', 'Цифры']);
  });

  it('у ветви страниц называет и сами страницы', () => {
    // Вывоз ветви даёт десятки листов, и понять по ним состав документа
    // нечем: названия страниц и есть его верхний уровень.
    const box = render([
      { pageId: 'p1', title: 'Первая', content: { type: 'doc', content: [heading(1, 'Раз')] } },
      { pageId: 'p2', title: 'Вторая', content: { type: 'doc', content: [heading(1, 'Два')] } }
    ]);

    expect(contents(box)).toEqual(['Первая', 'Раз', 'Вторая', 'Два']);
  });

  it('одного заголовка для оглавления мало', () => {
    const box = render([
      { pageId: 'p1', title: 'Отчёт', content: { type: 'doc', content: [heading(1, 'Итоги')] } }
    ]);

    expect(box.querySelector('[data-component="PrintToc"]')).toBeNull();
  });
});

describe('Лист для печати', () => {
  it('не готов, пока нарисована не каждая страница', () => {
    const box = render(two);
    expect(ready(box)).toBe(false);

    [...box.querySelectorAll('[data-component="ReadyProbe"]')][0].dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    flushSync();
    expect(ready(box)).toBe(false);
  });

  it('готов, когда нарисованы все', () => {
    const box = render(two);
    for (const probe of box.querySelectorAll('[data-component="ReadyProbe"]')) {
      probe.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    flushSync();
    expect(ready(box)).toBe(true);
  });

  it('пустое задание готово сразу: ждать нечего', () => {
    const box = render([]);
    expect(ready(box)).toBe(true);
  });

  it('перестаёт ждать застрявшую страницу', () => {
    vi.useFakeTimers();
    const box = render(two);
    expect(ready(box)).toBe(false);

    // Иначе одна незагрузившаяся страница держит печать до истечения срока, и
    // заказчик получает отказ вместо документа.
    vi.advanceTimersByTime(15001);
    flushSync();
    expect(ready(box)).toBe(true);
  });
});
