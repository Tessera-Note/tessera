import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DocxExportService } from './docx-export.service';

const PAGE = {
  id: 'page-1',
  spaceId: 'space-1',
  title: 'Руководство по развертыванию',
  deletedAt: null,
  content: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Первый абзац документа.' }],
      },
    ],
  },
};

// Наименьший корректный PNG, сериализатор читает по нему размеры.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function build(
  options: {
    page?: any;
    viewThrows?: boolean;
    attachment?: any;
    readThrows?: boolean;
    fileContent?: Buffer;
  } = {},
) {
  const pageRepo: any = {
    findById: jest
      .fn()
      .mockResolvedValue('page' in options ? options.page : PAGE),
  };
  const pageAccessService: any = {
    validateCanView: jest.fn(async () => {
      if (options.viewThrows) throw new ForbiddenException();
    }),
  };
  const attachmentRepo: any = {
    findById: jest
      .fn()
      .mockResolvedValue(
        'attachment' in options
          ? options.attachment
          : { id: 'att-1', spaceId: 'space-1', filePath: 'p', deletedAt: null },
      ),
  };
  const storageService: any = {
    read: jest.fn(async () => {
      if (options.readThrows) throw new Error('хранилище недоступно');
      return options.fileContent ?? PNG_1X1;
    }),
  };

  const service = new DocxExportService(
    pageRepo,
    pageAccessService,
    attachmentRepo,
    storageService,
  );
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});
  return { service, pageAccessService, storageService, attachmentRepo };
}

const USER = { id: 'user-1' } as any;

describe('DocxExportService, выгрузка страницы', () => {
  // Сериализатор вызывается настоящий, а не подменяется: проверять надо, что
  // на выходе получается открываемый файл, а не что вызвана функция.
  it('отдает буфер настоящего docx', async () => {
    const { service } = build();

    const file = await service.exportPage('page-1', USER);

    expect(Buffer.isBuffer(file.buffer)).toBe(true);
    expect(file.buffer.length).toBeGreaterThan(0);
    // docx это zip, сигнатура PK.
    expect(file.buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('имя файла берется из заголовка страницы', async () => {
    const { service } = build();

    const file = await service.exportPage('page-1', USER);

    expect(file.fileName).toBe('Руководство по развертыванию.docx');
  });

  it('страница без заголовка получает запасное имя', async () => {
    const { service } = build({ page: { ...PAGE, title: null } });

    const file = await service.exportPage('page-1', USER);

    expect(file.fileName).toBe('untitled.docx');
  });

  it('несуществующая страница дает 404', async () => {
    const { service } = build({ page: undefined });

    await expect(service.exportPage('page-1', USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('удаленная страница дает 404', async () => {
    const { service } = build({ page: { ...PAGE, deletedAt: new Date() } });

    await expect(service.exportPage('page-1', USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // Доступ проверяется через PageAccessService, а не по членству
  // в пространстве: страница внутри доступного пространства может быть закрыта.
  it('отказ в доступе пробрасывается наружу', async () => {
    const { service, pageAccessService } = build({ viewThrows: true });

    await expect(service.exportPage('page-1', USER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(pageAccessService.validateCanView).toHaveBeenCalled();
  });

  it('пустое содержимое не роняет выгрузку', async () => {
    const { service } = build({ page: { ...PAGE, content: null } });

    const file = await service.exportPage('page-1', USER);

    expect(file.buffer.length).toBeGreaterThan(0);
  });
});

describe('DocxExportService, картинки в документе', () => {
  const withImage = (src: string) => ({
    ...PAGE,
    content: {
      type: 'doc',
      content: [{ type: 'image', attrs: { src, width: 100, align: 'center' } }],
    },
  });

  it('картинка страницы читается из хранилища', async () => {
    const { service, storageService } = build({
      page: withImage('/files/11111111-1111-4111-8111-111111111111/a.png'),
    });

    await service.exportPage('page-1', USER);

    expect(storageService.read).toHaveBeenCalled();
  });

  it('абсолютная ссылка на вложение тоже распознается', async () => {
    const { service, storageService } = build({
      page: withImage(
        'https://example.com/api/files/11111111-1111-4111-8111-111111111111/a.png',
      ),
    });

    await service.exportPage('page-1', USER);

    expect(storageService.read).toHaveBeenCalled();
  });

  // Ссылка на чужое вложение, вписанная руками, не должна вытащить
  // его содержимое в файл.
  it('вложение чужого пространства в документ не попадает', async () => {
    const { service, storageService } = build({
      page: withImage('/files/11111111-1111-4111-8111-111111111111/a.png'),
      attachment: { id: 'att-1', spaceId: 'другое', filePath: 'p' },
    });

    await service.exportPage('page-1', USER);

    expect(storageService.read).not.toHaveBeenCalled();
  });

  it('удаленное вложение в документ не попадает', async () => {
    const { service, storageService } = build({
      page: withImage('/files/11111111-1111-4111-8111-111111111111/a.png'),
      attachment: { id: 'att-1', spaceId: 'space-1', deletedAt: new Date() },
    });

    await service.exportPage('page-1', USER);

    expect(storageService.read).not.toHaveBeenCalled();
  });

  // Одна битая картинка не должна ронять выгрузку всего документа.
  it('сбой чтения не роняет выгрузку', async () => {
    const { service } = build({
      page: withImage('/files/11111111-1111-4111-8111-111111111111/a.png'),
      readThrows: true,
    });

    const file = await service.exportPage('page-1', USER);

    expect(file.buffer.length).toBeGreaterThan(0);
  });

  it('внешняя картинка не по адресу вложения пропускается', async () => {
    const { service, storageService } = build({
      page: withImage('https://example.com/logo.png'),
    });

    const file = await service.exportPage('page-1', USER);

    expect(storageService.read).not.toHaveBeenCalled();
    expect(file.buffer.length).toBeGreaterThan(0);
  });
});

/**
 * Регресс со стенда: реальная страница со встроенной базой роняла выгрузку
 * с ошибкой «Token type `base` not supported by Word renderer». Сборка и
 * тесты на синтетическом документе этого не показывали.
 */
describe('DocxExportService, узлы редактора Tessera', () => {
  const withNode = (node: any) => ({
    ...PAGE,
    content: { type: 'doc', content: [node] },
  });

  it('встроенная база не роняет выгрузку', async () => {
    const { service } = build({
      page: withNode({ type: 'base', attrs: { pageId: 'base-1' } }),
    });

    const file = await service.exportPage('page-1', USER);

    expect(file.buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('синхронизированный блок сохраняет свой текст', async () => {
    const { service } = build({
      page: withNode({
        type: 'shared',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Текст общего блока' }],
          },
        ],
      }),
    });

    const file = await service.exportPage('page-1', USER);

    expect(file.buffer.length).toBeGreaterThan(0);
  });

  // Редактор расширяют чаще, чем сериализатор: незнакомый узел не должен
  // ронять выгрузку всего документа.
  it('незнакомый тип узла не роняет выгрузку', async () => {
    const { service } = build({
      page: withNode({ type: 'узелИзБудущего', attrs: {} }),
    });

    const file = await service.exportPage('page-1', USER);

    expect(file.buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('незнакомый узел с детьми сохраняет вложенный текст', async () => {
    const { service } = build({
      page: withNode({
        type: 'узелИзБудущего',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Вложенный текст' }],
          },
        ],
      }),
    });

    const file = await service.exportPage('page-1', USER);

    expect(file.buffer.length).toBeGreaterThan(0);
  });

  it('выноска и колонки выгружаются', async () => {
    const { service } = build({
      page: withNode({
        type: 'callout',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Предупреждение' }],
          },
        ],
      }),
    });

    const file = await service.exportPage('page-1', USER);

    expect(file.buffer.length).toBeGreaterThan(0);
  });
});
