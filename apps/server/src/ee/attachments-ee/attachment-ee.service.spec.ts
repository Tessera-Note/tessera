import { AttachmentEeService, IndexStatus } from './attachment-ee.service';
import { Readable } from 'stream';

const ATTACHMENT = {
  id: 'att-1',
  filePath: 'space/att-1.txt',
  mimeType: 'text/plain',
  fileExt: '.txt',
  fileSize: 12,
};

function build(
  options: {
    attachment?: any;
    content?: Buffer;
    readThrows?: boolean;
    pending?: { id: string }[];
  } = {},
) {
  const updates: { values: any; id?: string }[] = [];

  const selectChain: any = {
    select: () => selectChain,
    where: () => selectChain,
    executeTakeFirst: async () =>
      'attachment' in options ? options.attachment : ATTACHMENT,
    execute: async () => options.pending ?? [],
  };

  const db: any = {
    selectFrom: () => selectChain,
    updateTable: () => {
      const chain: any = {
        set: (values: any) => {
          updates.push({ values });
          return chain;
        },
        where: () => chain,
        execute: async () => [],
      };
      return chain;
    },
  };

  const storageService: any = {
    read: jest.fn(async () => {
      if (options.readThrows) throw new Error('хранилище недоступно');
      return options.content ?? Buffer.from('привет мир');
    }),
    readRangeStream: jest.fn(async () => {
      if (options.readThrows) throw new Error('хранилище недоступно');
      return Readable.from([options.content ?? Buffer.from('длинный текст')]);
    }),
  };

  const service = new AttachmentEeService(db, storageService);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});
  return { service, updates, storageService };
}

describe('AttachmentEeService, определение поддерживаемого типа', () => {
  const service = build().service;

  it.each([
    ['text/plain', '.txt'],
    ['text/markdown', '.md'],
    ['text/csv', '.csv'],
    ['application/json', '.json'],
  ])('тип %s поддерживается', (mime, ext) => {
    expect(service.isSupported(mime, ext)).toBe(true);
  });

  it.each([
    ['application/pdf', '.pdf'],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.docx',
    ],
    ['image/png', '.png'],
    ['video/mp4', '.mp4'],
  ])('тип %s не поддерживается', (mime, ext) => {
    expect(service.isSupported(mime, ext)).toBe(false);
  });

  // MIME приходит с параметрами, они не должны мешать сравнению.
  it('кодировка в MIME-типе не мешает', () => {
    expect(service.isSupported('text/plain; charset=utf-8', '.txt')).toBe(true);
  });

  // Запасной признак: когда прием отдал octet-stream, решает расширение.
  it('при octet-stream решает расширение', () => {
    expect(service.isSupported('application/octet-stream', '.md')).toBe(true);
    expect(service.isSupported('application/octet-stream', '.png')).toBe(false);
  });

  it('расширение без точки тоже распознается', () => {
    expect(service.isSupported('application/octet-stream', 'json')).toBe(true);
  });

  it('отсутствие и типа, и расширения не поддерживается', () => {
    expect(service.isSupported(null, null)).toBe(false);
  });
});

describe('AttachmentEeService, разбор одного вложения', () => {
  it('текстовый файл получает текст и отметку extracted', async () => {
    const { service, updates } = build({
      content: Buffer.from('содержимое файла'),
    });

    await service.indexAttachment('att-1');

    expect(updates).toHaveLength(1);
    expect(updates[0].values.textContent).toBe('содержимое файла');
    expect(updates[0].values.indexStatus).toBe(IndexStatus.Extracted);
  });

  // Неподдерживаемый тип это не ошибка: отметка нужна, чтобы повторный
  // проход такие файлы не перебирал.
  it('неподдерживаемый тип получает отметку unsupported без чтения файла', async () => {
    const { service, updates, storageService } = build({
      attachment: {
        ...ATTACHMENT,
        mimeType: 'application/pdf',
        fileExt: '.pdf',
      },
    });

    await service.indexAttachment('att-1');

    expect(updates).toHaveLength(1);
    expect(updates[0].values.indexStatus).toBe(IndexStatus.Unsupported);
    expect(updates[0].values.textContent).toBeUndefined();
    expect(storageService.read).not.toHaveBeenCalled();
  });

  // Сбой хранилища не должен «съедать» вложение: состояние остается
  // прежним, чтобы повтор задачи имел смысл.
  it('сбой чтения не меняет состояние', async () => {
    const { service, updates } = build({ readThrows: true });

    await service.indexAttachment('att-1');

    expect(updates).toHaveLength(0);
  });

  it('удаленное или отсутствующее вложение пропускается', async () => {
    const { service, updates } = build({ attachment: undefined });

    await service.indexAttachment('att-1');

    expect(updates).toHaveLength(0);
  });

  it('большой файл читается ограниченным куском', async () => {
    const { service, storageService, updates } = build({
      attachment: { ...ATTACHMENT, fileSize: 50 * 1024 * 1024 },
      content: Buffer.from('начало большого файла'),
    });

    await service.indexAttachment('att-1');

    expect(storageService.readRangeStream).toHaveBeenCalled();
    expect(storageService.read).not.toHaveBeenCalled();
    expect(updates[0].values.indexStatus).toBe(IndexStatus.Extracted);
  });

  // Границы две: сначала байтовая при чтении, затем символьная при
  // сохранении. Символьная совпадает с границей, до которой триггер
  // строит tsvector, хранить сверх нее нечего.
  it('файл сверх границы обрезается, а не отвергается', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const { service, updates } = build({
      attachment: { ...ATTACHMENT, fileSize: null },
      content: big,
    });

    await service.indexAttachment('att-1');

    expect(updates[0].values.indexStatus).toBe(IndexStatus.Extracted);
    expect(updates[0].values.textContent.length).toBe(1_000_000);
  });
});

describe('AttachmentEeService, проход по рабочему пространству', () => {
  it('обрабатывает только необработанные записи', async () => {
    const { service, updates } = build({
      pending: [{ id: 'a1' }, { id: 'a2' }],
    });

    const processed = await service.indexAttachments('ws-1');

    expect(processed).toBe(2);
    expect(updates).toHaveLength(2);
  });

  it('пустой список не приводит к записям', async () => {
    const { service, updates } = build({ pending: [] });

    const processed = await service.indexAttachments('ws-1');

    expect(processed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  // Сбой на одном файле не должен отменять остальные.
  it('сбой на одной записи не прерывает проход', async () => {
    const { service } = build({ pending: [{ id: 'a1' }, { id: 'a2' }] });
    const spy = jest
      .spyOn(service, 'indexAttachment')
      .mockRejectedValueOnce(new Error('сбой'))
      .mockResolvedValueOnce(undefined);

    const processed = await service.indexAttachments('ws-1');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(processed).toBe(1);
  });
});
