import { describe, expect, it } from 'vitest';

import { highlightHtml } from './highlight';

describe('отрывок поиска', () => {
  it('подсветка совпадения остаётся разметкой', () => {
    expect(highlightHtml('текст про <b>поиск</b>')).toBe('текст про <b>поиск</b>');
  });

  it('чужая разметка не доезжает до страницы', () => {
    // Отрывок строится из содержимого страницы, то есть из того, что пишет
    // человек: вставленный как есть, он выполняется в чужом браузере.
    const value = highlightHtml('до <script>alert(1)</script> после');
    expect(value).not.toContain('<script>');
    expect(value).toContain('&lt;script&gt;');
  });

  it('обработчик события в атрибуте тоже экранируется', () => {
    const value = highlightHtml('<img src=x onerror="alert(1)">');
    expect(value).not.toContain('<img');
    expect(value).not.toContain('onerror="');
  });

  it('амперсанд не превращается в сущность дважды', () => {
    expect(highlightHtml('Иванов &amp; сыновья')).toBe('Иванов &amp;amp; сыновья');
  });

  it('пустой отрывок это пустая строка', () => {
    expect(highlightHtml(null)).toBe('');
    expect(highlightHtml(undefined)).toBe('');
  });
});
