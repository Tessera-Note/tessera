/**
 * Проверка идёт в наборе с окном: модуль настроек доходит до слоя обращений к
 * серверу, а тот начинается с `$app/environment`. Подмены этих модулей
 * объявлены только там.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRASH_RETENTION_DAYS, trashRetentionShown } from './settings';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAINTENANCE = join(
  HERE,
  ...Array(6).fill('..'),
  'api',
  'tessera_api',
  'services',
  'maintenance.py'
);

describe('срок корзины', () => {
  it('по умолчанию совпадает со сроком, который ждёт очистка', () => {
    const match = /^DEFAULT_TRASH_RETENTION_DAYS = (\d+)$/m.exec(readFileSync(MAINTENANCE, 'utf8'));
    expect(match).not.toBeNull();
    expect(DEFAULT_TRASH_RETENTION_DAYS).toBe(Number(match![1]));
  });

  it('пустое поле показывает срок по умолчанию, а не ноль', () => {
    expect(trashRetentionShown('')).toBe(DEFAULT_TRASH_RETENTION_DAYS);
    expect(trashRetentionShown('  ')).toBe(DEFAULT_TRASH_RETENTION_DAYS);
  });

  it('заданный срок показывается как есть', () => {
    expect(trashRetentionShown('7')).toBe(7);
    expect(trashRetentionShown('1.5')).toBe(1.5);
  });

  it('недопустимое значение показывает срок по умолчанию', () => {
    // Сохранить его сервер не даст, а подсказка не должна обещать ноль дней.
    expect(trashRetentionShown('0')).toBe(DEFAULT_TRASH_RETENTION_DAYS);
    expect(trashRetentionShown('abc')).toBe(DEFAULT_TRASH_RETENTION_DAYS);
  });
});
