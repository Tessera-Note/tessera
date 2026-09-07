/**
 * Заголовки документа для оглавления.
 *
 * Порядок здесь тот же, что в показанной разметке: по нему оглавление и
 * находит, куда переводить взгляд. Расхождение означало бы переход не туда, и
 * заметить его человек не сможет — он видит правильный текст в оглавлении.
 */

import { describe, expect, it } from 'vitest';
import { headings } from './document';

/** Абзац документа редактора. */
function text(value: string) {
  return { type: 'text', text: value };
}

function heading(level: number, value: string) {
  return { type: 'heading', attrs: { level }, content: [text(value)] };
}

describe('headings', () => {
  it('берёт заголовки по порядку документа', () => {
    const doc = {
      type: 'doc',
      content: [
        heading(1, 'Начало'),
        { type: 'paragraph', content: [text('Между ними')] },
        heading(2, 'Середина'),
        heading(3, 'Конец')
      ]
    };

    expect(headings(doc)).toEqual([
      { level: 1, text: 'Начало' },
      { level: 2, text: 'Середина' },
      { level: 3, text: 'Конец' }
    ]);
  });

  it('пропускает пустой заголовок', () => {
    // Пустая строка в оглавлении ведёт в никуда и ни о чём не говорит.
    const doc = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 1 }, content: [] }, heading(2, 'Живой')]
    };
    expect(headings(doc)).toEqual([{ level: 2, text: 'Живой' }]);
  });

  it('находит заголовок внутри чужого узла', () => {
    // Заголовки живут и в столбцах, и в выносках. Пропустить их — значит
    // сбить счёт, а по счёту оглавление и находит заголовок в разметке.
    const doc = {
      type: 'doc',
      content: [
        heading(1, 'Первый'),
        {
          type: 'columns',
          content: [{ type: 'column', content: [heading(2, 'В столбце')] }]
        }
      ]
    };
    expect(headings(doc)).toEqual([
      { level: 1, text: 'Первый' },
      { level: 2, text: 'В столбце' }
    ]);
  });

  it('без уровня считает заголовок первым', () => {
    const doc = { type: 'doc', content: [{ type: 'heading', content: [text('Без уровня')] }] };
    expect(headings(doc)).toEqual([{ level: 1, text: 'Без уровня' }]);
  });

  it('на пустоте отдаёт пустой перечень', () => {
    expect(headings(null)).toEqual([]);
    expect(headings({ type: 'doc', content: [] })).toEqual([]);
  });
});
