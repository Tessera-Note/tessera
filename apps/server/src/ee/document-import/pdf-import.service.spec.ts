import { BadRequestException } from '@nestjs/common';
import { PdfImportService } from './pdf-import.service';

jest.mock('@docmost/pdf-inspector', () => ({
  processPdf: jest.fn(),
}));

import { processPdf } from '@docmost/pdf-inspector';

const processPdfMock = processPdf as unknown as jest.Mock;

const TEXT_RESULT = {
  pdfType: 'TextBased',
  pageCount: 2,
  markdown: '# Политика\n\nТекст документа.\n',
  pagesNeedingOcr: [],
  confidence: 1,
};

function build(result: any = TEXT_RESULT, throws = false) {
  processPdfMock.mockReset();
  processPdfMock.mockImplementation(() => {
    if (throws) throw new Error('битый файл');
    return result;
  });

  const service = new PdfImportService();
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  return { service };
}

const BUF = Buffer.from('%PDF-1.4 ...');
const convert = (service: PdfImportService) =>
  service.convertPdfToHtml(BUF, 'ws-1', 'space-1', 'page-1', 'user-1');

describe('PdfImportService, текстовый PDF', () => {
  it('markdown превращается в html', async () => {
    const { service } = build();

    const html = await convert(service);

    expect(html).toContain('<h1>');
    expect(html).toContain('Политика');
    expect(html).toContain('Текст документа');
  });

  // Часть страниц без текстового слоя это не отказ: остальные переносятся.
  it('часть страниц без текста не отменяет импорт', async () => {
    const { service } = build({ ...TEXT_RESULT, pagesNeedingOcr: [2] });

    await expect(convert(service)).resolves.toContain('Политика');
  });

  it('смешанный тип с текстом переносится', async () => {
    const { service } = build({ ...TEXT_RESULT, pdfType: 'Mixed' });

    await expect(convert(service)).resolves.toContain('Политика');
  });
});

/**
 * Пользователь должен получить внятное сообщение, а не пустую страницу.
 * Измерено на стенде: скан классифицируется как Scanned, PDF из картинки
 * как ImageBased, markdown в обоих случаях отсутствует.
 */
describe('PdfImportService, PDF без текстового слоя', () => {
  const expectClearMessage = async (result: any) => {
    const { service } = build(result);

    await expect(convert(service)).rejects.toThrow(/нет текстового слоя/i);
    await expect(convert(service)).rejects.toBeInstanceOf(BadRequestException);
  };

  it('скан отклоняется с объяснением', async () => {
    await expectClearMessage({
      pdfType: 'Scanned',
      pageCount: 1,
      markdown: undefined,
      pagesNeedingOcr: [1],
    });
  });

  it('PDF из картинок отклоняется с объяснением', async () => {
    await expectClearMessage({
      pdfType: 'ImageBased',
      pageCount: 1,
      markdown: undefined,
      pagesNeedingOcr: [1],
    });
  });

  // Тип может оказаться текстовым, а текста не быть: пустая страница
  // пользователю все равно не нужна.
  it('текстовый тип без текста тоже отклоняется', async () => {
    await expectClearMessage({
      pdfType: 'TextBased',
      pageCount: 1,
      markdown: '   \n  ',
      pagesNeedingOcr: [],
    });
  });

  it('отсутствие markdown отклоняется', async () => {
    await expectClearMessage({
      pdfType: 'TextBased',
      pageCount: 1,
      markdown: null,
      pagesNeedingOcr: [],
    });
  });
});

describe('PdfImportService, ошибки разбора', () => {
  it('пустой файл отвергается', async () => {
    const { service } = build();

    await expect(
      service.convertPdfToHtml(
        Buffer.alloc(0),
        'ws-1',
        'space-1',
        'page-1',
        'user-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('битый файл дает 400, а не 500', async () => {
    const { service } = build(TEXT_RESULT, true);

    await expect(convert(service)).rejects.toBeInstanceOf(BadRequestException);
  });
});
