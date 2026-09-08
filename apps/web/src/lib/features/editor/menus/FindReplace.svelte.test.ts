/**
 * Панель поиска и замены.
 *
 * Проверяется главное: набранное доходит до редактора. Поддельный редактор
 * повторяет настоящую связку — команда шлёт транзакцию, а на транзакции хозяин
 * панели правит свой счётчик правок. Из-за этой связки эффект, вызывающий
 * команды напрямую, оказывался подписан на то, что сам же и пишет, и Svelte
 * останавливал его после десятого витка: строка до редактора не доходила.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import FindReplace from './FindReplace.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

type Storage = {
  searchTerm: string;
  replaceTerm: string;
  caseSensitive: boolean;
  results: { from: number; to: number }[];
  resultIndex: number;
};

/** Счётчик правок хозяина панели. Правится обычным присваиванием, как в `Editor.svelte`. */
const ticks = $state({ value: 0 });

function fakeEditor(storage: Storage) {
  const transaction = () => {
    ticks.value += 1;
  };
  const commands = {
    setSearchTerm(value: string) {
      storage.searchTerm = value;
      transaction();
    },
    setReplaceTerm(value: string) {
      storage.replaceTerm = value;
      transaction();
    },
    setCaseSensitive(value: boolean) {
      storage.caseSensitive = value;
      transaction();
    },
    resetIndex() {
      storage.resultIndex = 0;
      transaction();
    },
    nextSearchResult() {
      storage.resultIndex += 1;
      transaction();
    },
    previousSearchResult() {
      storage.resultIndex -= 1;
      transaction();
    },
    selectCurrentItem() {
      transaction();
    }
  };
  return { storage: { searchAndReplace: storage }, commands };
}

function render(storage: Storage, onclose: () => void = () => {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(FindReplace, {
    target: host,
    props: {
      editor: fakeEditor(storage) as never,
      get tick() {
        return ticks.value;
      },
      onclose
    }
  }) as Record<string, unknown>;
  flushSync();
  return host;
}

function empty(): Storage {
  return { searchTerm: '', replaceTerm: '', caseSensitive: false, results: [], resultIndex: 0 };
}

function type(box: HTMLElement, selector: string, value: string): void {
  const field = box.querySelector<HTMLInputElement>(selector);
  if (!field) throw new Error(`нет поля ${selector}`);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
  ticks.value = 0;
});

describe('FindReplace', () => {
  it('передаёт набранную строку редактору', () => {
    const storage = empty();
    const box = render(storage);
    type(box, 'input[type="search"]', 'оглав');
    expect(storage.searchTerm).toBe('оглав');
  });

  it('передаёт строку замены отдельно от строки поиска', () => {
    const storage = empty();
    const box = render(storage);
    type(box, 'input[type="text"]', 'содержания');
    expect(storage.replaceTerm).toBe('содержания');
    expect(storage.searchTerm).toBe('');
  });

  it('переключатель регистра доходит до редактора', () => {
    const storage = empty();
    const box = render(storage);
    const button = box.querySelector<HTMLButtonElement>('button[aria-pressed]');
    button?.click();
    flushSync();
    expect(storage.caseSensitive).toBe(true);
  });

  it('показывает число найденного по счётчику правок', () => {
    const storage = empty();
    const box = render(storage);
    storage.results = [
      { from: 1, to: 5 },
      { from: 9, to: 13 }
    ];
    type(box, 'input[type="search"]', 'ог');
    expect(box.querySelector('[aria-live="polite"]')?.textContent?.trim()).toBe('1/2');
  });

  it('закрытие снимает запрос', () => {
    const storage = empty();
    let closed = false;
    const box = render(storage, () => (closed = true));
    type(box, 'input[type="search"]', 'ог');
    const close = [...box.querySelectorAll('button')].at(-1);
    close?.click();
    flushSync();
    expect(storage.searchTerm).toBe('');
    expect(closed).toBe(true);
  });
});
