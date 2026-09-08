import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_LABELS, toolCalls, toolLabel } from './tools';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', '..', '..', '..', 'static', 'locales', 'en-US.json');

describe('toolLabel', () => {
  const t = (key: string) => `[${key}]`;

  it('переводит известное имя', () => {
    expect(toolLabel('search_web', t)).toBe('[Searched the web]');
  });

  it('незнакомое имя показывает как есть', () => {
    expect(toolLabel('delete_base_view', t)).toBe('delete_base_view');
  });

  it('без имени не показывает ничего', () => {
    expect(toolLabel(null, t)).toBe('');
    expect(toolLabel(undefined, t)).toBe('');
    expect(toolLabel('', t)).toBe('');
  });

  it('все названия заведены в источнике словарей', () => {
    // Ключ стоит значением описи, а не в вызове `t('...')`. Общая проверка
    // словарей ищет вызовы и такие строки пропускает — они уходили бы в перевод
    // мимо переводчика и показывались по-английски во всех локалях.
    const source = JSON.parse(readFileSync(SOURCE, 'utf8')) as Record<string, string>;
    const missing = Object.values(TOOL_LABELS).filter((key) => !(key in source));
    expect(missing).toEqual([]);
  });
});

describe('toolCalls', () => {
  it('берёт список вызовов', () => {
    const raw = [{ id: '1', name: 'get_page', args: {}, result: 'ok' }];
    expect(toolCalls(raw)).toHaveLength(1);
  });

  it('не список превращает в пустоту', () => {
    expect(toolCalls(null)).toEqual([]);
    expect(toolCalls(undefined)).toEqual([]);
    expect(toolCalls('search_web')).toEqual([]);
    expect(toolCalls({ name: 'get_page' })).toEqual([]);
  });

  it('отбрасывает записи, у которых нечего показывать', () => {
    // Разговор старше текущей записи мог сохранить что угодно, и обращение к
    // `name` у строки уронило бы весь транскрипт.
    expect(toolCalls(['get_page', null, { id: '2', name: 'get_page' }])).toEqual([
      { id: '2', name: 'get_page' }
    ]);
  });
});
