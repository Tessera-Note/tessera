/**
 * Распознавание вставленной ссылки на ролик.
 *
 * Проверяется сам разбор адреса, без редактора: он и решает, станет ли
 * вставленное проигрывателем или останется обычной ссылкой.
 */

import { describe, expect, it } from 'vitest';
import { embedFromLink } from './embed-paste';

describe('вставленная ссылка на ролик', () => {
  it('обычный адрес просмотра становится проигрывателем', () => {
    const found = embedFromLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(found?.provider).toBe('youtube');
    // Через `nocookie`: обычный адрес ставит следящие куки ещё до нажатия
    // «смотреть», и решать это за читателя вика не должна.
    expect(found?.src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });

  it('короткий адрес', () => {
    expect(embedFromLink('https://youtu.be/dQw4w9WgXcQ')?.provider).toBe('youtube');
  });

  it('готовый адрес проигрывателя остаётся как есть', () => {
    const found = embedFromLink('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(found?.src).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('лишние доводы в адресе не мешают', () => {
    expect(embedFromLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')?.provider).toBe(
      'youtube'
    );
  });

  it('другие службы тоже узнаются', () => {
    expect(embedFromLink('https://vimeo.com/123456789')?.provider).toBe('vimeo');
  });

  it('незнакомый адрес остаётся обычной ссылкой', () => {
    // Разбор отвечает «iframe» на всё подряд, и без этой проверки любая
    // вставленная ссылка превращалась бы во встроенное окно.
    expect(embedFromLink('https://example.com/страница')).toBeNull();
  });

  it('не адрес вовсе', () => {
    expect(embedFromLink('просто текст')).toBeNull();
    expect(embedFromLink('')).toBeNull();
    expect(embedFromLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ и ещё текст')).toBeNull();
  });

  it('чужие схемы отвергаются', () => {
    // `javascript:` во встроенном окне — это выполнение чужого кода на нашей
    // странице.
    expect(embedFromLink('javascript:alert(1)')).toBeNull();
    expect(embedFromLink('data:text/html,<script>alert(1)</script>')).toBeNull();
  });
});
