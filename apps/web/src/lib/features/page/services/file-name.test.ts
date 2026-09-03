import { describe, expect, it } from 'vitest';
import { fileNameOf } from './file-name';

describe('fileNameOf', () => {
  it('берёт имя в кодировке UTF-8, когда оно есть', () => {
    const header =
      'attachment; filename="%D0%9F%D0%BB%D0%B0%D0%BD.md"; filename*=UTF-8\'\'%D0%9F%D0%BB%D0%B0%D0%BD.md';
    expect(fileNameOf(header, 'запасное.md')).toBe('План.md');
  });

  it('берёт обычное поле, когда второго нет', () => {
    expect(fileNameOf('attachment; filename="plan.md"', 'запасное.md')).toBe('plan.md');
  });

  it('раскодирует обычное поле', () => {
    expect(fileNameOf('attachment; filename="%D0%9F%D0%BB%D0%B0%D0%BD.md"', 'x.md')).toBe(
      'План.md'
    );
  });

  it('без заголовка берёт запасное имя', () => {
    expect(fileNameOf(null, 'запасное.md')).toBe('запасное.md');
    expect(fileNameOf('attachment', 'запасное.md')).toBe('запасное.md');
  });

  it('испорченную кодировку не роняет', () => {
    expect(fileNameOf("attachment; filename*=UTF-8''%E0%A4%A", 'запасное.md')).toBe('запасное.md');
    expect(fileNameOf('attachment; filename="%E0%A4%A"', 'запасное.md')).toBe('%E0%A4%A');
  });
});
