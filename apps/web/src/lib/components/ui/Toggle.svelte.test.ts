/**
 * Проверка разметки: компонент собирается и вставляется в настоящий DOM.
 *
 * Отдельным видом от разбора данных: там проверяется, что функция считает
 * правильно, здесь — что человек видит и что происходит по нажатию. Среда
 * берётся по имени файла (`*.svelte.test.ts`), см. `vite.config.ts`. Своего
 * браузера в проверках нет и не появится: это была бы новая зависимость,
 * которая ещё и качает бинарник из интернета.
 */

import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Toggle from './Toggle.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

type Props = ComponentProps<typeof Toggle>;

function render(props: Partial<Props> & Pick<Props, 'checked' | 'label' | 'onchange'>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(Toggle, { target: host, props }) as Record<string, unknown>;
  flushSync();
  return host;
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('Toggle', () => {
  it('показывает подпись и пояснение', () => {
    const box = render({
      checked: false,
      label: 'Включить',
      hint: 'что это меняет',
      onchange: () => {}
    });
    expect(box.textContent).toContain('Включить');
    expect(box.textContent).toContain('что это меняет');
  });

  it('отражает переданное состояние', () => {
    const box = render({ checked: true, label: 'Включить', onchange: () => {} });
    expect(box.querySelector('input')?.checked).toBe(true);
  });

  it('сообщает о нажатии новым значением', () => {
    const onchange = vi.fn();
    const box = render({ checked: false, label: 'Включить', onchange });

    const input = box.querySelector('input') as HTMLInputElement;
    input.click();
    flushSync();

    expect(onchange).toHaveBeenCalledWith(true);
  });

  it('возвращает флажок к прежнему виду до ответа сервера', () => {
    // Смысл проверки в этом: флажок не должен показывать включённым то, что
    // включить ещё не удалось. Меняет его только обновление данных страницы.
    const box = render({ checked: false, label: 'Включить', onchange: () => {} });

    const input = box.querySelector('input') as HTMLInputElement;
    input.click();
    flushSync();

    expect(input.checked).toBe(false);
  });

  it('выключенный не нажимается', () => {
    const onchange = vi.fn();
    const box = render({ checked: false, label: 'Включить', disabled: true, onchange });

    const input = box.querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    input.click();
    flushSync();
    expect(onchange).not.toHaveBeenCalled();
  });
});
