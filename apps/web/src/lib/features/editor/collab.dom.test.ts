/**
 * Запасное чтение тела страницы.
 *
 * Нужно там, где схема этой версии тело не разбирает: узла нет, а слова есть.
 * Пустой лист в этом случае неотличим от потери текста, поэтому текст
 * вынимается из разметки как есть.
 */

import { describe, expect, it } from 'vitest';
import { plainText } from './collab';

describe('plainText', () => {
  it('собирает абзацы отдельными строками', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Первый' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Второй' }] }
      ]
    };

    expect(plainText(content)).toEqual(['Первый', 'Второй']);
  });

  it('склеивает куски одного абзаца, а не рвёт их', () => {
    // Абзац с выделением состоит из нескольких узлов текста, и разрывать его
    // по ним значило бы показывать по слову на строке.
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Слово ' },
            { type: 'text', text: 'жирное', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' и дальше' }
          ]
        }
      ]
    };

    expect(plainText(content)).toEqual(['Слово жирное и дальше']);
  });

  it('достаёт текст из вложенной разметки', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Пункт' }] }]
            }
          ]
        }
      ]
    };

    expect(plainText(content)).toEqual(['Пункт']);
  });

  it('незнакомый узел текст соседей не уносит', () => {
    // Ровно тот случай, ради которого запасное чтение и заведено: узел из
    // будущей версии стоит рядом с обычными абзацами.
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'До' }] },
        { type: 'узелИзБудущего', attrs: { чего: 'нибудь' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'После' }] }
      ]
    };

    expect(plainText(content)).toEqual(['До', 'После']);
  });

  it('узлы без текста строк не добавляют', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'horizontalRule' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Единственная' }] }
      ]
    };

    expect(plainText(content)).toEqual(['Единственная']);
  });

  it('пустое и негодное тело дают пустой перечень, а не отказ', () => {
    // Тело приходит из базы и бывает каким угодно: отказ здесь означал бы
    // пустую страницу вместо запасного показа.
    expect(plainText(null)).toEqual([]);
    expect(plainText({})).toEqual([]);
    expect(plainText({ type: 'doc', content: [] })).toEqual([]);
    expect(plainText('строка')).toEqual([]);
  });
});
