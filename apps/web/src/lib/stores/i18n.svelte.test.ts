/**
 * Хранилище языка под эффектом слоя.
 *
 * Проверяется не перевод, а живучесть ветви эффектов. `apply` зовут из
 * эффекта корневого слоя, и стоит ему прочитать то, что он сам записал, как
 * Svelte считает это бесконечным обновлением и снимает всю ветвь — молча,
 * вместе со всем деревом ниже. Приложение остаётся с разметкой первой
 * отрисовки: панель редактора не появляется, подпись «Загрузка...» не уходит,
 * ни одного отказа при этом не видно.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import LocaleEffectProbe from '../../test-stubs/LocaleEffectProbe.svelte';
import { locale } from './i18n.svelte';

let host: HTMLElement | null = null;
let component: Record<string, unknown> | null = null;

const RU = { 'Loading...': 'Загрузка...' };
const EN = { 'Loading...': 'Loading...' };

function render(props: { current: string; dictionary: Record<string, string> }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(LocaleEffectProbe, { target: host, props }) as Record<string, unknown>;
  flushSync();
}

function text(): string {
  return host?.querySelector('[data-component="LocaleEffectProbe"]')?.textContent?.trim() ?? '';
}

afterEach(() => {
  if (component) void unmount(component);
  host?.remove();
  component = null;
  host = null;
});

describe('locale.apply под эффектом', () => {
  it('не уходит в бесконечное обновление', () => {
    expect(() => render({ current: 'ru-RU', dictionary: RU })).not.toThrow();
    expect(text()).toBe('Загрузка...');
  });

  it('оставляет ветвь эффектов живой: смена языка доходит до показа', () => {
    // Настоящая проверка. Снятая ветвь не мешает первой отрисовке, и без
    // второго применения отказ был бы невидим.
    render({ current: 'ru-RU', dictionary: RU });

    locale.apply('en-US', EN);
    flushSync();

    expect(text()).toBe('Loading...');
  });

  it('ставит язык на самой странице', () => {
    render({ current: 'ru-RU', dictionary: RU });
    expect(document.documentElement.lang).toBe('ru-RU');
  });
});
