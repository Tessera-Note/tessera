import { AgentImageService } from './agent-image.service';

/**
 * Агент вставлял в страницу адрес найденного изображения как есть, поэтому
 * браузер читателя шёл за картинкой на чужой сервер, тогда как остальной
 * продукт работает в закрытом контуре.
 */
const TARGET = {
  pageId: 'p-1',
  spaceId: 'sp-1',
  workspaceId: 'ws-1',
  userId: 'u-1',
};

function build(response?: { status?: number; type?: string; bytes?: number }) {
  const attachmentRepo: any = { insertAttachment: jest.fn(async () => {}) };
  const storageService: any = { upload: jest.fn(async () => {}) };

  const service = new AgentImageService(attachmentRepo, storageService);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});

  const status = response?.status ?? 200;
  global.fetch = jest.fn(async () => ({
    ok: status < 400,
    status,
    headers: { get: () => response?.type ?? 'image/png' },
    arrayBuffer: async () => new ArrayBuffer(response?.bytes ?? 32),
  })) as any;

  return { service, attachmentRepo, storageService };
}

describe('AgentImageService.localizeImages', () => {
  it('внешний адрес заменяется внутренним', async () => {
    const { service } = build();

    const out = await service.localizeImages(
      'Текст\n\n![Постер](https://example.org/poster.png)\n',
      TARGET,
    );

    expect(out).not.toContain('example.org');
    expect(out).toMatch(
      /!\[Постер\]\(\/api\/files\/[\w-]+\/image-[\w-]+\.png\)/,
    );
  });

  it('файл кладется в хранилище и записывается вложением страницы', async () => {
    const { service, storageService, attachmentRepo } = build();

    await service.localizeImages('![a](https://example.org/a.png)', TARGET);

    expect(storageService.upload).toHaveBeenCalled();
    expect(attachmentRepo.insertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'p-1', spaceId: 'sp-1' }),
    );
  });

  /**
   * Оставить внешний адрес значило бы сохранить ровно то, ради чего перенос и
   * делается.
   */
  it('не перенесенная картинка убирается из разметки', async () => {
    const { service } = build({ status: 404 });

    const out = await service.localizeImages(
      'До ![a](https://example.org/a.png) после',
      TARGET,
    );

    expect(out).toBe('До  после');
    expect(out).not.toContain('example.org');
  });

  it('неизвестный тип содержимого не переносится', async () => {
    const { service, storageService } = build({ type: 'text/html' });

    const out = await service.localizeImages(
      '![a](https://example.org/a.png)',
      TARGET,
    );

    expect(storageService.upload).not.toHaveBeenCalled();
    expect(out).toBe('');
  });

  it('слишком большая картинка не переносится', async () => {
    const { service, storageService } = build({ bytes: 11 * 1024 * 1024 });

    await service.localizeImages('![a](https://example.org/a.png)', TARGET);

    expect(storageService.upload).not.toHaveBeenCalled();
  });

  it('текст без картинок не трогается и в сеть не ходит', async () => {
    const { service } = build();
    const markdown = '# Заголовок\n\nОбычный текст со ссылкой [тут](https://a)';

    await expect(service.localizeImages(markdown, TARGET)).resolves.toBe(
      markdown,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('внутренний адрес не трогается', async () => {
    const { service } = build();
    const markdown = '![a](/api/files/abc/image.png)';

    await expect(service.localizeImages(markdown, TARGET)).resolves.toBe(
      markdown,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('несколько картинок переносятся все', async () => {
    const { service, storageService } = build();

    await service.localizeImages(
      '![a](https://example.org/a.png) ![b](https://example.org/b.png)',
      TARGET,
    );

    expect(storageService.upload).toHaveBeenCalledTimes(2);
  });

  it('пустое содержимое возвращается как есть', async () => {
    const { service } = build();

    await expect(service.localizeImages('', TARGET)).resolves.toBe('');
  });
});
