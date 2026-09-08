/**
 * Копирование в буфер обмена.
 *
 * Заведена после находки ревью: копирование было записано как
 * `navigator.clipboard?.writeText(...)`, и в незащищённом соединении знак `?.`
 * тихо гасил вызов — человек уходил с уверенностью, что ссылка у него в
 * буфере. Проверяется, что отказ доходит до вызывающего.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

function withClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', {
    value,
    configurable: true,
    writable: true
  });
}

afterEach(() => {
  withClipboard(undefined);
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('копирует и отвечает успехом', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard({ writeText });

    expect(await copyText('ссылка')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('ссылка');
  });

  it('без буфера отвечает отказом, а не притворяется', async () => {
    // Так выглядит развёртывание по `http://`: свойства нет вовсе.
    withClipboard(undefined);
    expect(await copyText('ссылка')).toBe(false);
  });

  it('отказ браузера не выходит наружу исключением', async () => {
    withClipboard({ writeText: vi.fn().mockRejectedValue(new Error('нет прав')) });
    expect(await copyText('ссылка')).toBe(false);
  });
});
