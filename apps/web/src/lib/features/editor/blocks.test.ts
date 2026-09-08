import { describe, expect, it } from 'vitest';
import { BLOCKS, findBlocks, pagelessBlocks } from './blocks';

/** Словарь-пустышка: подписи и есть ключи, перевод возвращает их же. */
const same = (key: string) => key;

/** Словарь с русскими подписями: по ним тоже надо находить. */
const russian = (key: string) => (key === 'Table' ? 'Таблица' : key);

describe('findBlocks', () => {
  it('на пустом запросе отдаёт всё', () => {
    expect(findBlocks('', same)).toHaveLength(BLOCKS.length);
  });

  it('находит по подписи', () => {
    expect(findBlocks('callout', same).map((block) => block.id)).toContain('callout');
  });

  it('находит по словам для поиска', () => {
    expect(findBlocks('whiteboard', same).map((block) => block.id)).toContain('excalidraw');
    expect(findBlocks('spreadsheet', same).map((block) => block.id)).toContain('base');
  });

  it('находит по переведённой подписи', () => {
    expect(findBlocks('таблиц', russian).map((block) => block.id)).toContain('table');
  });

  it('ставит совпадение подписи целиком выше разрозненного', () => {
    const order = findBlocks('tab', same).map((block) => block.id);
    expect(order[0]).toBe('table');
  });

  it('ничего не находит на бессмысленном запросе', () => {
    expect(findBlocks('щщщ', same)).toEqual([]);
  });

  it('опознаётся по имени без повторов', () => {
    const ids = BLOCKS.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('без страницы не предлагает загрузку и базы', () => {
    const ids = pagelessBlocks().map((block) => block.id);
    for (const needs of ['image', 'video', 'audio', 'pdf', 'attachment', 'base', 'kanban']) {
      expect(ids).not.toContain(needs);
    }
    // Остальное остаётся: без страницы вставляется всё, что живёт в документе.
    expect(ids).toContain('table');
    expect(ids).toContain('callout');
    expect(ids.length).toBe(BLOCKS.length - 7);
  });

  it('у каждого блока есть подпись и слова для поиска', () => {
    for (const block of BLOCKS) {
      expect(block.label.length).toBeGreaterThan(0);
      expect(block.keywords.length).toBeGreaterThan(0);
    }
  });
});
