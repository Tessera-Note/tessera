import { PdfExportService } from './pdf-export.service';

/**
 * Страница отрисовки при отказе помечает себя готовой и показывает текст
 * ошибки, чтобы выгрузка не висела до таймаута. Браузер отдает такую страницу
 * обычным PDF, поэтому файл сохранялся, а задача помечалась успешной: человек
 * получал «готовую» выгрузку с текстом отказа внутри. Молчаливой порчи быть
 * не должно, отказ обязан быть отказом.
 */
function build(renderDataFails: boolean) {
  const service: PdfExportService = Object.create(PdfExportService.prototype);
  const updates: any[] = [];

  const chain: any = {
    selectAll: () => chain,
    set: (values: any) => {
      updates.push(values);
      return chain;
    },
    where: () => chain,
    execute: async () => [],
    executeTakeFirst: async () => ({
      id: 'task-1',
      pageId: 'page-1',
      workspaceId: 'ws-1',
      filePath: '/tmp/x.pdf',
    }),
  };

  (service as any).db = {
    selectFrom: () => chain,
    updateTable: () => chain,
  };
  (service as any).logger = { error: jest.fn(), debug: jest.fn() };
  (service as any).tokenService = {
    generatePdfRenderToken: jest.fn(async () => 'token'),
  };
  (service as any).storageService = { upload: jest.fn(async () => undefined) };

  const renderPdf = jest.fn(async () => Buffer.from('pdf'));
  (service as any).renderPdf = renderPdf;

  const getRenderData = jest.fn(async () => {
    if (renderDataFails) throw new Error('Invalid or expired render token');
    return { pages: [{ id: 'page-1' }] };
  });
  (service as any).getRenderData = getRenderData;

  const failTask = jest.fn(async () => undefined);
  (service as any).failTask = failTask;

  return { service, renderPdf, failTask, updates, getRenderData };
}

describe('PdfExportService.generateAndStorePdf', () => {
  it('исправные данные доходят до отрисовки и задача успешна', async () => {
    const { service, renderPdf, updates } = build(false);

    await service.generateAndStorePdf('task-1');

    expect(renderPdf).toHaveBeenCalled();
    expect(updates.some((u) => u.fileSize !== undefined)).toBe(true);
  });

  /** Главное: до браузера дело не доходит, «успеха» не возникает. */
  it('негодные данные не доходят до браузера и успехом не считаются', async () => {
    const { service, renderPdf, failTask, updates } = build(true);

    // Отказ пробрасывается наружу: очередь должна увидеть неудачу задачи.
    await expect(service.generateAndStorePdf('task-1')).rejects.toThrow();

    expect(renderPdf).not.toHaveBeenCalled();
    expect(updates.some((u) => u.fileSize !== undefined)).toBe(false);
    expect(failTask).toHaveBeenCalled();
  });
});
