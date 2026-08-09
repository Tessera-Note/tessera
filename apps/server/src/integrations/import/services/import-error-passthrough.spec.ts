import { ImportService } from './import.service';
import { badRequest } from '../../../common/errors/app-error';

/**
 * Регресс: общий обработчик сворачивал любую ошибку разбора в текст
 * «Error processing file content». Пользователь, загрузивший скан без
 * текстового слоя, видел непонятное сообщение вместо причины отказа.
 *
 * Проверяется, что до него доходит код отказа: по коду клиент показывает
 * перевод, тогда как текст пришел бы на языке серверного кода.
 */
describe('ImportService, сообщение об отказе доходит до пользователя', () => {
  const build = (thrown: Error) => {
    const service = Object.create(ImportService.prototype) as any;
    service.logger = { error: jest.fn(), debug: jest.fn() };
    service.processPdf = jest.fn().mockRejectedValue(thrown);
    service.processDocx = jest.fn().mockRejectedValue(thrown);
    return service;
  };

  const file = (name: string) =>
    ({
      filename: name,
      toBuffer: async () => Buffer.from('содержимое'),
    }) as any;

  const importFile = (service: any, name: string) =>
    ImportService.prototype.importPage.call(
      service,
      file(name),
      'user-1',
      'space-1',
      'ws-1',
    );

  it('осознанное сообщение разборщика PDF не подменяется', async () => {
    const service = build(badRequest('error.import.pdf_no_text_layer'));

    await expect(importFile(service, 'скан.pdf')).rejects.toMatchObject({
      response: { code: 'error.import.pdf_no_text_layer' },
    });
  });

  it('осознанное сообщение разборщика Word не подменяется', async () => {
    const service = build(badRequest('error.import.docx_unreadable'));

    await expect(importFile(service, 'битый.docx')).rejects.toMatchObject({
      response: { code: 'error.import.docx_unreadable' },
    });
  });

  // Внутренние детали наружу не отдаются.
  it('неожиданная ошибка сворачивается в общее сообщение', async () => {
    const service = build(new Error('ENOENT /внутренний/путь'));

    await expect(importFile(service, 'скан.pdf')).rejects.toThrow(
      'Error processing file content',
    );
  });
});
