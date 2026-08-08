import { BadRequestException } from '@nestjs/common';
import * as mammoth from 'mammoth';
import { DocxImportService } from './docx-import.service';

jest.mock('mammoth', () => ({
  images: {
    // Настоящий mammoth зовет обработчик на каждой картинке и подставляет
    // возвращенный src. Здесь он сохраняется, чтобы тест мог его вызвать.
    imgElement: jest.fn((handler: any) => {
      (globalThis as any).__imgHandler = handler;
      return handler;
    }),
  },
  convertToHtml: jest.fn(),
}));

function build(
  options: {
    convertResult?: any;
    convertThrows?: boolean;
    uploadThrows?: boolean;
    insertThrows?: boolean;
  } = {},
) {
  const inserted: any[] = [];
  const uploaded: { path: string; size: number }[] = [];

  const attachmentRepo: any = {
    insertAttachment: jest.fn(async (values: any) => {
      if (options.insertThrows) throw new Error('база недоступна');
      inserted.push(values);
      return values;
    }),
  };
  const storageService: any = {
    upload: jest.fn(async (path: string, buffer: Buffer) => {
      if (options.uploadThrows) throw new Error('хранилище недоступно');
      uploaded.push({ path, size: buffer.length });
    }),
  };

  const convertToHtml = mammoth.convertToHtml as unknown as jest.Mock;
  convertToHtml.mockReset();
  convertToHtml.mockImplementation(async () => {
    if (options.convertThrows) throw new Error('битый архив');
    return options.convertResult ?? { value: '<p>Текст</p>', messages: [] };
  });

  const service = new DocxImportService(attachmentRepo, storageService);
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  return { service, inserted, uploaded, attachmentRepo, storageService };
}

const BUF = Buffer.from('PK документ');
const convert = (service: DocxImportService) =>
  service.convertDocxToHtml(BUF, 'ws-1', 'space-1', 'page-1', 'user-1');

describe('DocxImportService, разбор документа', () => {
  it('возвращает html для дальнейшего разбора', async () => {
    const { service } = build();

    await expect(convert(service)).resolves.toBe('<p>Текст</p>');
  });

  it('пустой файл отвергается', async () => {
    const { service } = build();

    await expect(
      service.convertDocxToHtml(
        Buffer.alloc(0),
        'ws-1',
        'space-1',
        'page-1',
        'user-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('битый документ дает понятную ошибку, а не 500', async () => {
    const { service } = build({ convertThrows: true });

    await expect(convert(service)).rejects.toBeInstanceOf(BadRequestException);
  });

  // Замечания разбора не ошибка: mammoth сообщает о стилях без соответствия
  // в HTML, документ при этом переносится.
  it('замечания разбора не мешают переносу', async () => {
    const { service } = build({
      convertResult: {
        value: '<p>Текст</p>',
        messages: [{ message: 'Unrecognised paragraph style' }],
      },
    });

    await expect(convert(service)).resolves.toBe('<p>Текст</p>');
  });

  it('пустой результат разбора дает пустую строку', async () => {
    const { service } = build({ convertResult: { value: null, messages: [] } });

    await expect(convert(service)).resolves.toBe('');
  });
});

describe('DocxImportService, картинки документа', () => {
  const image = (contentType: string, size = 10) => ({
    contentType,
    read: async () => Buffer.alloc(size, 1),
  });

  const runHandler = async (service: DocxImportService, img: any) => {
    await convert(service);
    return (globalThis as any).__imgHandler(img);
  };

  it('картинка переносится во вложения и получает ссылку редактора', async () => {
    const { service, inserted, uploaded } = build();

    const result = await runHandler(service, image('image/png'));

    expect(uploaded).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].pageId).toBe('page-1');
    expect(inserted[0].spaceId).toBe('space-1');
    expect(inserted[0].creatorId).toBe('user-1');
    expect(result.src).toMatch(/^\/api\/files\/[0-9a-f-]{36}\/image-.*\.png$/);
  });

  it.each([
    ['image/jpeg', '.jpg'],
    ['image/gif', '.gif'],
    ['image/webp', '.webp'],
    ['image/svg+xml', '.svg'],
  ])('тип %s сохраняется с расширением %s', async (mime, ext) => {
    const { service, inserted } = build();

    await runHandler(service, image(mime));

    expect(inserted[0].fileExt).toBe(ext);
  });

  // Класть в хранилище файл с расширением, которого не понимает ни редактор,
  // ни браузер, смысла нет.
  it('неизвестный тип картинки не сохраняется', async () => {
    const { service, uploaded } = build();

    const result = await runHandler(service, image('application/x-neizvestno'));

    expect(uploaded).toHaveLength(0);
    expect(result.src).toBe('');
  });

  it('картинка сверх границы не сохраняется', async () => {
    const { service, uploaded } = build();

    const result = await runHandler(
      service,
      image('image/png', 21 * 1024 * 1024),
    );

    expect(uploaded).toHaveLength(0);
    expect(result.src).toBe('');
  });

  it('пустая картинка не сохраняется', async () => {
    const { service, uploaded } = build();

    const result = await runHandler(service, image('image/png', 0));

    expect(uploaded).toHaveLength(0);
    expect(result.src).toBe('');
  });

  // Одна непереносимая картинка не должна отменять импорт всего документа.
  it('сбой хранилища не роняет импорт', async () => {
    const { service } = build({ uploadThrows: true });

    const result = await runHandler(service, image('image/png'));

    expect(result.src).toBe('');
  });

  it('сбой записи в базу не роняет импорт', async () => {
    const { service } = build({ insertThrows: true });

    const result = await runHandler(service, image('image/png'));

    expect(result.src).toBe('');
  });

  it('файл кладется в папку рабочего пространства', async () => {
    const { service, uploaded } = build();

    await runHandler(service, image('image/png'));

    expect(uploaded[0].path).toMatch(/^ws-1\/files\/[0-9a-f-]{36}\//);
  });
});
