import { describe, expect, it } from 'vitest';
import { isEmptyRichText, readRichText } from './rich-text';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });

describe('readRichText', () => {
  it('разбирает абзац с начертаниями', () => {
    const lines = readRichText(
      doc({
        type: 'paragraph',
        content: [text('раз '), text('два', [{ type: 'bold' }])]
      })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].block).toBe('paragraph');
    expect(lines[0].pieces).toEqual([
      {
        kind: 'text',
        text: 'раз ',
        bold: false,
        italic: false,
        strike: false,
        code: false,
        href: null
      },
      {
        kind: 'text',
        text: 'два',
        bold: true,
        italic: false,
        strike: false,
        code: false,
        href: null
      }
    ]);
  });

  it('берёт адрес из ссылки', () => {
    const lines = readRichText(
      doc({
        type: 'paragraph',
        content: [text('сюда', [{ type: 'link', attrs: { href: 'https://example.com' } }])]
      })
    );
    expect(lines[0].pieces[0]).toMatchObject({ href: 'https://example.com' });
  });

  it('разбирает упоминание человека и страницы', () => {
    const lines = readRichText(
      doc({
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { label: 'Пётр', entityType: 'user', entityId: 'u1' } },
          { type: 'mention', attrs: { label: 'План', entityType: 'page', slugId: 's1' } }
        ]
      })
    );
    expect(lines[0].pieces).toEqual([
      { kind: 'mention', label: 'Пётр', slugId: null, page: false },
      { kind: 'mention', label: 'План', slugId: 's1', page: true }
    ]);
  });

  it('различает виды блоков', () => {
    const lines = readRichText(
      doc(
        { type: 'paragraph', content: [text('раз')] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [text('два')] }] },
        { type: 'codeBlock', content: [text('три')] }
      )
    );
    expect(lines.map((line) => line.block)).toEqual(['paragraph', 'quote', 'code']);
  });

  it('не теряет текст в узле неизвестного вида', () => {
    const lines = readRichText(
      doc({ type: 'somethingNew', content: [{ type: 'paragraph', content: [text('цел')] }] })
    );
    expect(lines[0].pieces[0]).toMatchObject({ text: 'цел' });
  });

  it('пустой документ не даёт строк', () => {
    expect(readRichText(doc({ type: 'paragraph' }))).toEqual([]);
    expect(readRichText(null)).toEqual([]);
    expect(isEmptyRichText(doc({ type: 'paragraph' }))).toBe(true);
    expect(isEmptyRichText(doc({ type: 'paragraph', content: [text('есть')] }))).toBe(false);
  });
});
