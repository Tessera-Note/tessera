/**
 * Запасное чтение тела страницы.
 *
 * Нужно там, где схема этой версии тело не разбирает: узла нет, а слова есть.
 * Пустой лист в этом случае неотличим от потери текста, поэтому текст
 * вынимается из разметки как есть.
 */

import { describe, expect, it } from 'vitest';
import { collabAddress, documentName, nextStatus, plainText, seedDecision } from './collab';

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

describe('nextStatus', () => {
  it('состоявшееся подключение даёт рабочее состояние', () => {
    expect(nextStatus('connecting', 'connected')).toBe('ready');
    expect(nextStatus('offline', 'connected')).toBe('ready');
  });

  it('повторная попытка после разрыва не выводит из разрыва', () => {
    // Библиотека повторяет попытки и о каждой сообщает `connecting`. Приняв
    // это за начальную загрузку, экран затирал бы сообщение о потерянной
    // связи словом «загрузка».
    expect(nextStatus('offline', 'connecting')).toBe('offline');
    expect(nextStatus('offline', 'disconnected')).toBe('offline');
  });

  it('до первого подключения это именно загрузка', () => {
    expect(nextStatus('connecting', 'connecting')).toBe('connecting');
    expect(nextStatus('ready', 'connecting')).toBe('connecting');
  });
});

describe('seedDecision', () => {
  const content = { type: 'doc', content: [{ type: 'paragraph' }] };

  it('один источник — ещё не решение', () => {
    // Документ приходит с сервера и из хранилища браузера. Засев по одному из
    // них пришёлся бы на миг, когда второе ещё не применено, и страница
    // показала бы своё содержимое дважды.
    expect(seedDecision({ fromServer: true, fromBrowser: false, empty: true, content })).toBe(
      'wait'
    );
    expect(seedDecision({ fromServer: false, fromBrowser: true, empty: true, content })).toBe(
      'wait'
    );
  });

  it('пустой документ у непустой страницы засевается', () => {
    expect(seedDecision({ fromServer: true, fromBrowser: true, empty: true, content })).toBe(
      'seed'
    );
  });

  it('непустой документ не трогается', () => {
    // Тело уже в документе: повторный засев удвоил бы его.
    expect(seedDecision({ fromServer: true, fromBrowser: true, empty: false, content })).toBe(
      'skip'
    );
  });

  it('пустой странице класть нечего', () => {
    expect(seedDecision({ fromServer: true, fromBrowser: true, empty: true, content: null })).toBe(
      'skip'
    );
  });
});

describe('collabAddress', () => {
  it('несёт имя документа доводом адреса', () => {
    // Прокси закрепляет соединение за репликой по адресу: первое сообщение
    // протокола, где имя идёт для сервера, он не разбирает.
    const address = new URL(collabAddress(documentName('abc')));
    expect(address.pathname).toBe('/collab');
    expect(address.searchParams.get('documentName')).toBe('page.abc');
  });

  it('берёт схему у страницы', () => {
    expect(collabAddress('page.x').startsWith('ws://')).toBe(true);
  });
});
