jest.mock('@docmost/pdf-inspector', () => ({
  processPdf: jest.fn(),
}));
jest.mock('mammoth', () => ({
  convertToHtml: jest.fn(),
}));

import { processPdf } from '@docmost/pdf-inspector';
import * as mammoth from 'mammoth';
import { docxText, pdfText } from './document-text';

const processPdfMock = processPdf as jest.Mock;
const convertToHtmlMock = mammoth.convertToHtml as unknown as jest.Mock;

/**
 * От поиска по вложениям ждут в первую очередь PDF и DOCX. Разбирают их те же
 * библиотеки, что уже стоят ради импорта документов, поэтому новой
 * зависимости не заводится. Импорт строит из них содержимое страницы, здесь
 * нужен только текст.
 */
describe('Текст из документов', () => {
  afterEach(() => jest.resetAllMocks());

  it('из PDF остаются слова, а не разметка', () => {
    processPdfMock.mockReturnValue({
      markdown: '# Регламент\n\nОтпуск **24** дня.\n\n[ссылка](http://a)',
    });

    const text = pdfText(Buffer.from('x'));

    expect(text).toContain('Регламент');
    expect(text).toContain('Отпуск 24 дня.');
    expect(text).toContain('ссылка');
    expect(text).not.toContain('#');
    expect(text).not.toContain('http://a');
  });

  /** У PDF из сканов текстового слоя нет: искать в нем нечего. */
  it('PDF без текста дает пусто', () => {
    processPdfMock.mockReturnValue({ markdown: '' });

    expect(pdfText(Buffer.from('x'))).toBe('');
  });

  /** Один битый файл не должен останавливать обход всего пространства. */
  it('битый PDF дает пусто, а не исключение', () => {
    processPdfMock.mockImplementation(() => {
      throw new Error('encrypted');
    });

    expect(() => pdfText(Buffer.from('x'))).not.toThrow();
    expect(pdfText(Buffer.from('x'))).toBe('');
  });

  it('из DOCX снимается разметка', async () => {
    convertToHtmlMock.mockResolvedValue({
      value: '<h1>Договор</h1><p>Срок&nbsp;&mdash; 12 месяцев</p>',
    });

    const text = await docxText(Buffer.from('x'));

    expect(text).toContain('Договор');
    expect(text).toContain('12 месяцев');
    expect(text).not.toContain('<');
  });

  it('скрипты и стили в текст не попадают', async () => {
    convertToHtmlMock.mockResolvedValue({
      value: '<style>p{color:red}</style><p>Текст</p><script>alert(1)</script>',
    });

    const text = await docxText(Buffer.from('x'));

    expect(text).toBe('Текст');
  });

  it('битый DOCX дает пусто, а не исключение', async () => {
    convertToHtmlMock.mockRejectedValue(new Error('not a zip'));

    await expect(docxText(Buffer.from('x'))).resolves.toBe('');
  });
});
