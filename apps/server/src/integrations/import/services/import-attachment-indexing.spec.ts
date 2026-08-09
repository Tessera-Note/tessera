// Модуль тянет ESM-пакеты, которые сборка тестов сервера не разбирает.
// Проверяется постановка задачи разбора, к загрузке файлов эти пакеты
// отношения не имеют.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (fn: any) => fn(),
}));
jest.mock('image-dimensions', () => ({
  __esModule: true,
  imageDimensionsFromData: () => undefined,
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImportAttachmentService } from './import-attachment.service';

/**
 * Импорт ставил задачу разбора содержимого только на `.pdf` и `.docx`, то есть
 * ровно на те типы, которые извлекатель считает неподдерживаемыми, а
 * импортированные `.md`, `.txt` и `.json` в очередь не попадали вовсе и
 * навсегда оставались в состоянии «не обработано».
 *
 * Решение о поддержке типа принимает извлекатель, в одном месте, поэтому
 * задача ставится на любое вложение, как и при обычной загрузке.
 */
function build() {
  const service: ImportAttachmentService = Object.create(
    ImportAttachmentService.prototype,
  );

  const inserted: any[] = [];
  (service as any).db = {
    insertInto: () => ({
      values: (row: any) => {
        inserted.push(row);
        return { execute: async () => [] };
      },
    }),
  };

  const queue = { add: jest.fn(async () => {}) };
  (service as any).attachmentQueue = queue;
  (service as any).storageService = {
    uploadStream: jest.fn(async (_path: string, stream: any) => {
      // Поток надо вычитать, иначе он останется висеть и уронит процесс.
      for await (const _chunk of stream) void _chunk;
    }),
  };
  (service as any).logger = {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  };
  (service as any).MAX_RETRIES = 1;
  (service as any).RETRY_DELAY = 0;

  return { service, queue, inserted };
}

// Загрузка читает файл потоком, поэтому файлы настоящие.
let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-attachment-'));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const uploadStats = {
  total: 1,
  completed: 0,
  failed: 0,
  failedFiles: [] as string[],
};

async function upload(service: ImportAttachmentService, ext: string) {
  const abs = path.join(tempDir, `файл${ext}`);
  fs.writeFileSync(abs, 'содержимое');

  await (service as any).uploadWithRetry({
    abs,
    storageFilePath: `ws/att/файл${ext}`,
    attachmentId: 'att-1',
    fileNameWithExt: `файл${ext}`,
    ext,
    pageId: 'p-1',
    fileTask: {
      creatorId: 'u-1',
      workspaceId: 'ws-1',
      spaceId: 'sp-1',
    } as any,
    uploadStats: { ...uploadStats },
  });
}

describe('ImportAttachmentService, разбор содержимого', () => {
  it.each(['.md', '.txt', '.json', '.csv'])(
    'импортированный %s попадает в очередь разбора',
    async (ext) => {
      const { service, queue } = build();

      await upload(service, ext);

      expect(queue.add).toHaveBeenCalledWith(
        'attachment-index-content',
        { attachmentId: 'att-1' },
        expect.anything(),
      );
    },
  );

  /**
   * Отметку «тип не поддерживается» тоже кто-то должен проставить, иначе такой
   * файл неотличим от еще не дошедшего до разбора.
   */
  it.each(['.pdf', '.docx', '.png'])(
    'неразбираемый %s тоже попадает в очередь ради отметки',
    async (ext) => {
      const { service, queue } = build();

      await upload(service, ext);

      expect(queue.add).toHaveBeenCalled();
    },
  );

  it('отказ очереди не отменяет загрузки вложения', async () => {
    const { service, queue, inserted } = build();
    queue.add.mockRejectedValue(new Error('очередь недоступна'));

    await expect(upload(service, '.md')).resolves.toBeUndefined();

    expect(inserted).toHaveLength(1);
  });
});
