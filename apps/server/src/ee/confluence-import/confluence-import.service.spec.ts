import { promises as fs } from 'fs';
import { ConfluenceImportService } from './confluence-import.service';

jest.mock(
  '../../integrations/import/services/import-attachment.service',
  () => ({ ImportAttachmentService: class ImportAttachmentService {} }),
);

jest.mock('../../integrations/import/utils/import.utils', () => ({
  buildAttachmentCandidates: jest.fn(async () => new Map()),
}));

jest.mock('../../integrations/import/utils/import-formatter', () => ({
  formatImportHtml: jest.fn(async ({ html, sourcePageId }) => ({
    html,
    backlinks: (globalThis as any).__backlinksFor?.(sourcePageId) ?? [],
    pageIcon: undefined,
  })),
}));

const INDEX = `
<div id="main-content"><div class="pageSection"><ul>
  <li><a href="Reglament_1.html">Регламент</a>
    <ul><li><a href="Prilozhenie_2.html">Приложение</a></li></ul>
  </li>
  <li><a href="Slovar_3.html">Словарь</a></li>
</ul></div></div>`;

const page = (title: string, body: string) =>
  `<span id="title-text">${title}</span><div id="main-content"><p>${body}</p></div>`;

const FILES: Record<string, string> = {
  'index.html': INDEX,
  'Reglament_1.html': page('Регламент', 'Текст регламента'),
  'Prilozhenie_2.html': page('Приложение', 'Текст приложения'),
  'Slovar_3.html': page('Словарь', 'Текст словаря'),
};

function build(files: Record<string, string> = FILES) {
  const inserts: any[] = [];

  jest.spyOn(fs, 'access').mockImplementation(async (p: any) => {
    const name = String(p).split('/').pop()!;
    if (!(name in files)) {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
  });
  jest.spyOn(fs, 'readFile').mockImplementation(async (p: any) => {
    const name = String(p).split('/').pop()!;
    if (!(name in files)) {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return files[name] as any;
  });
  jest.spyOn(fs, 'readdir').mockResolvedValue([] as any);

  const db: any = {
    selectFrom: () => {
      const chain: any = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => ({ slug: 'general' }),
      };
      return chain;
    },
    transaction: () => ({
      execute: async (cb: (trx: any) => Promise<unknown>) =>
        cb({
          insertInto: () => ({
            values: (v: any) => {
              inserts.push(v);
              return { execute: async () => [] };
            },
          }),
        }),
    }),
  };

  const importService: any = {
    // Пустой текстовый узел ProseMirror не принимает, настоящий processHTML
    // его и не создает: на пустом входе получается пустой абзац.
    processHTML: jest.fn(async (html: string) => ({
      type: 'doc',
      content: [
        html
          ? { type: 'paragraph', content: [{ type: 'text', text: html }] }
          : { type: 'paragraph' },
      ],
    })),
    extractTitleAndRemoveHeading: jest.fn((pm: any) => ({
      title: '',
      prosemirrorJson: pm,
    })),
    createYdoc: jest.fn(async () => null),
  };
  const pageService: any = {
    nextPagePosition: jest.fn(async () => 'a0'),
  };

  const attachmentCalls: any[] = [];
  const importAttachmentService: any = {
    processAttachments: jest.fn(async (opts: any) => {
      attachmentCalls.push(opts);
      return opts.html;
    }),
  };

  const moduleRef: any = {
    get: (token: any) =>
      token?.name === 'ImportAttachmentService'
        ? importAttachmentService
        : importService,
  };
  const insertedBacklinks: any[] = [];
  const backlinkRepo: any = {
    insertBacklink: jest.fn(async (link: any) => {
      insertedBacklinks.push(link);
    }),
  };

  const service = new ConfluenceImportService(
    db,
    moduleRef,
    pageService,
    backlinkRepo,
  );
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});
  return { service, inserts, attachmentCalls, insertedBacklinks };
}

const FILE_TASK = {
  id: 'task-1',
  spaceId: 'space-1',
  workspaceId: 'ws-1',
  creatorId: 'user-1',
} as any;

const run = (service: ConfluenceImportService) =>
  service.processConfluenceImport({
    extractDir: '/tmp/extract',
    fileTask: FILE_TASK,
  });

afterEach(() => jest.restoreAllMocks());

describe('ConfluenceImportService, перенос структуры', () => {
  it('создаются все страницы выгрузки', async () => {
    const { service, inserts } = build();

    await run(service);

    expect(inserts).toHaveLength(3);
    expect(inserts.map((p) => p.title)).toEqual(
      expect.arrayContaining(['Регламент', 'Приложение', 'Словарь']),
    );
  });

  // Иерархия задана вложенными списками index.html, а не каталогами:
  // все страницы в архиве лежат плоско.
  it('вложенность берется из index.html', async () => {
    const { service, inserts } = build();

    await run(service);

    const reglament = inserts.find((p) => p.title === 'Регламент');
    const prilozhenie = inserts.find((p) => p.title === 'Приложение');
    const slovar = inserts.find((p) => p.title === 'Словарь');

    expect(reglament.parentPageId).toBeNull();
    expect(slovar.parentPageId).toBeNull();
    expect(prilozhenie.parentPageId).toBe(reglament.id);
  });

  // Родитель должен существовать до вставки потомка.
  it('родитель вставляется раньше потомка', async () => {
    const { service, inserts } = build();

    await run(service);

    const parentIdx = inserts.findIndex((p) => p.title === 'Регламент');
    const childIdx = inserts.findIndex((p) => p.title === 'Приложение');

    expect(parentIdx).toBeLessThan(childIdx);
  });

  it('содержимое страницы попадает в запись', async () => {
    const { service, inserts } = build();

    await run(service);

    const slovar = inserts.find((p) => p.title === 'Словарь');

    expect(JSON.stringify(slovar.content)).toContain('Текст словаря');
  });

  it('корневая страница возвращается для обновления дерева', async () => {
    const { service, inserts } = build();

    const rootId = await run(service);

    expect(rootId).toBe(inserts[0].id);
  });

  it('у каждой страницы есть позиция', async () => {
    const { service, inserts } = build();

    await run(service);

    expect(inserts).toHaveLength(3);
    expect(inserts.every((p) => typeof p.position === 'string')).toBe(true);
  });

  it('страницы пишутся в пространство и рабочее пространство задачи', async () => {
    const { service, inserts } = build();

    await run(service);

    expect(inserts).toHaveLength(3);
    expect(inserts.every((p) => p.spaceId === 'space-1')).toBe(true);
    expect(inserts.every((p) => p.workspaceId === 'ws-1')).toBe(true);
    expect(inserts.every((p) => p.creatorId === 'user-1')).toBe(true);
  });
});

describe('ConfluenceImportService, отказ от переноса', () => {
  it('архив без index.html не переносится', async () => {
    const { service, inserts } = build({ 'other.html': '<p>нет</p>' });

    await expect(run(service)).resolves.toBeNull();
    expect(inserts).toHaveLength(0);
  });

  // Признак берется из разметки: index.html есть в любом архиве.
  it('чужой архив с index.html не переносится', async () => {
    const { service, inserts } = build({
      'index.html': '<html><body><h1>Не Confluence</h1></body></html>',
    });

    await expect(run(service)).resolves.toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it('выгрузка без страниц не переносится', async () => {
    const { service, inserts } = build({
      'index.html':
        '<div id="main-content"><div class="pageSection"><ul></ul></div><a href="x.html">x</a></div>',
    });

    await run(service);

    expect(inserts).toHaveLength(0);
  });
});

describe('ConfluenceImportService, неполный архив', () => {
  // В index.html встречаются ссылки на страницы, которых в архиве нет.
  // Терять из-за них все пространство нельзя.
  it('отсутствующий файл страницы дает пустую страницу, остальные переносятся', async () => {
    const files = { ...FILES };
    delete files['Prilozhenie_2.html'];
    const { service, inserts } = build(files);

    await run(service);

    expect(inserts).toHaveLength(3);
    const prilozhenie = inserts.find((p) => p.title === 'Приложение');
    expect(prilozhenie).toBeDefined();
    expect(JSON.stringify(prilozhenie.content)).not.toContain('Текст');
  });

  it('заголовок берется из имени файла, если в странице его нет', async () => {
    const files = {
      ...FILES,
      'Slovar_3.html': '<div id="main-content"><p>Текст</p></div>',
    };
    const { service, inserts } = build(files);

    await run(service);

    // В index.html заголовок есть, он и побеждает.
    expect(inserts.find((p) => p.title === 'Словарь')).toBeDefined();
  });
});

/**
 * Обработка вложений Confluence уже написана в import-attachment.service:
 * пары draw.io, файлы без расширения, числовые имена. Часть 2 ее подключает.
 */
describe('ConfluenceImportService, вложения', () => {
  const PAGE_WITH_ATTACHMENT = `
    <span id="title-text">Регламент</span>
    <div id="main-content">
      <p>Текст</p>
      <div class="pageSection group"><h2>Attachments:</h2><div class="greybox">
        <a href="attachments/65601/65602.png">схема.png</a> (image/png)
        <a href="attachments/65601/65603">заметки</a> (application/octet-stream)
      </div></div>
    </div>`;

  const FILES_WITH_ATTACHMENT = {
    ...FILES,
    'Reglament_1.html': PAGE_WITH_ATTACHMENT,
  };

  it('обработка вложений вызывается для каждой страницы', async () => {
    const { service, attachmentCalls } = build();

    await run(service);

    expect(attachmentCalls).toHaveLength(3);
  });

  // Без этого признака не сработают ни пары draw.io, ни файлы
  // без расширения, ни сопоставление числовых имен.
  it('признак выгрузки Confluence передается', async () => {
    const { service, attachmentCalls } = build();

    await run(service);

    expect(attachmentCalls.every((c) => c.isConfluenceImport === true)).toBe(
      true,
    );
  });

  it('список вложений страницы передается разобранным', async () => {
    const { service, attachmentCalls } = build(FILES_WITH_ATTACHMENT);

    await run(service);

    const call = attachmentCalls.find((c) => c.pageAttachments.length > 0);
    expect(call.pageAttachments).toEqual([
      {
        href: 'attachments/65601/65602.png',
        fileName: 'схема.png',
        mimeType: 'image/png',
      },
      {
        href: 'attachments/65601/65603',
        fileName: 'заметки',
        mimeType: 'application/octet-stream',
      },
    ]);
  });

  // Регресс со стенда: ссылки на вложения в выгрузке заданы относительно
  // папки с index.html. Если считать корнем корень распаковки, ключи
  // кандидатов получат лишний префикс, и пара draw.io молча потеряется.
  it('корнем считается папка с index.html, а не корень распаковки', async () => {
    const { service, attachmentCalls } = build();

    await run(service);

    expect(attachmentCalls[0].pageRelativePath).toBe('Reglament_1.html');
    expect(attachmentCalls[0].extractDir).toBe('/tmp/extract');
  });

  it('страница без вложений дает пустой список, а не отказ', async () => {
    const { service, attachmentCalls } = build();

    await run(service);

    expect(attachmentCalls.every((c) => Array.isArray(c.pageAttachments))).toBe(
      true,
    );
  });

  it('идентификатор страницы передается для привязки вложений', async () => {
    const { service, attachmentCalls, inserts } = build();

    await run(service);

    const ids = inserts.map((p) => p.id);
    expect(attachmentCalls.every((c) => ids.includes(c.pageId))).toBe(true);
  });
});

/**
 * Настоящая выгрузка Confluence распаковывается в папку с ключом
 * пространства, а не в корень. Стенд показал, что при неверном корне
 * пара draw.io молча теряется: ключи кандидатов получают лишний префикс.
 */
describe('ConfluenceImportService, архив во вложенной папке', () => {
  const buildNested = () => {
    const inserts: any[] = [];
    const attachmentCalls: any[] = [];
    const files: Record<string, string> = {
      '/tmp/extract/OPS/index.html': INDEX,
      '/tmp/extract/OPS/Reglament_1.html': page('Регламент', 'Текст'),
      '/tmp/extract/OPS/Prilozhenie_2.html': page('Приложение', 'Текст'),
      '/tmp/extract/OPS/Slovar_3.html': page('Словарь', 'Текст'),
    };

    jest.spyOn(fs, 'access').mockImplementation(async (p: any) => {
      if (!(String(p) in files)) {
        const err: any = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
    });
    jest.spyOn(fs, 'readFile').mockImplementation(async (p: any) => {
      const key = String(p);
      if (!(key in files)) {
        const err: any = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return files[key] as any;
    });
    jest
      .spyOn(fs, 'readdir')
      .mockResolvedValue([
        { name: 'OPS', isDirectory: () => true },
      ] as any);

    const db: any = {
      selectFrom: () => {
        const chain: any = {
          select: () => chain,
          where: () => chain,
          executeTakeFirst: async () => ({ slug: 'general' }),
        };
        return chain;
      },
      transaction: () => ({
        execute: async (cb: (trx: any) => Promise<unknown>) =>
          cb({
            insertInto: () => ({
              values: (v: any) => {
                inserts.push(v);
                return { execute: async () => [] };
              },
            }),
          }),
      }),
    };

    const importService: any = {
      processHTML: jest.fn(async (html: string) => ({
        type: 'doc',
        content: [
          html
            ? { type: 'paragraph', content: [{ type: 'text', text: html }] }
            : { type: 'paragraph' },
        ],
      })),
      extractTitleAndRemoveHeading: jest.fn((pm: any) => ({
        title: '',
        prosemirrorJson: pm,
      })),
      createYdoc: jest.fn(async () => null),
    };
    const importAttachmentService: any = {
      processAttachments: jest.fn(async (opts: any) => {
        attachmentCalls.push(opts);
        return opts.html;
      }),
    };
    const moduleRef: any = {
      get: (token: any) =>
        token?.name === 'ImportAttachmentService'
          ? importAttachmentService
          : importService,
    };
    const service = new ConfluenceImportService(
      db,
      moduleRef,
      { nextPagePosition: jest.fn(async () => 'a0') } as any,
      { insertBacklink: jest.fn(async () => {}) } as any,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
    jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});
    return { service, inserts, attachmentCalls };
  };

  it('index.html находится во вложенной папке', async () => {
    const { service, inserts } = buildNested();

    await run(service);

    expect(inserts).toHaveLength(3);
  });

  it('корнем импорта становится папка архива', async () => {
    const { service, attachmentCalls } = buildNested();

    await run(service);

    expect(attachmentCalls[0].extractDir).toBe('/tmp/extract/OPS');
    expect(attachmentCalls[0].pageRelativePath).toBe('Reglament_1.html');
  });
});

/**
 * Часть 1 отбрасывала обратные ссылки, которые возвращает formatImportHtml:
 * связи между перенесенными страницами в базу не попадали.
 */
describe('ConfluenceImportService, обратные ссылки', () => {
  afterEach(() => {
    delete (globalThis as any).__backlinksFor;
  });

  const withBacklinks = (make: (sourcePageId: string) => any[]) => {
    (globalThis as any).__backlinksFor = make;
  };

  it('связи между перенесенными страницами записываются', async () => {
    const { service, inserts, insertedBacklinks } = build();
    const ids: string[] = [];
    withBacklinks((sourcePageId) => {
      ids.push(sourcePageId);
      return ids.length === 1
        ? []
        : [
            {
              sourcePageId,
              targetPageId: ids[0],
              workspaceId: 'ws-1',
            },
          ];
    });

    await run(service);

    expect(insertedBacklinks.length).toBeGreaterThan(0);
    expect(inserts.map((p) => p.id)).toEqual(
      expect.arrayContaining([insertedBacklinks[0].targetPageId]),
    );
  });

  // Обе стороны связи должны существовать, иначе внешний ключ отвергнет запись.
  it('связь на страницу вне выгрузки отбрасывается', async () => {
    const { service, insertedBacklinks } = build();
    withBacklinks((sourcePageId) => [
      { sourcePageId, targetPageId: 'страницы-нет', workspaceId: 'ws-1' },
    ]);

    await run(service);

    expect(insertedBacklinks).toHaveLength(0);
  });

  it('без связей записей не создается', async () => {
    const { service, insertedBacklinks } = build();

    await run(service);

    expect(insertedBacklinks).toHaveLength(0);
  });
});
