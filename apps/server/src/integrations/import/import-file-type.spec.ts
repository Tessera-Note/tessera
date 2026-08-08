import { BadRequestException } from '@nestjs/common';
import { ImportController } from './import.controller';

/**
 * Сообщение об отказе обязано называть допустимые расширения.
 *
 * Google Docs выгружает документ в семи форматах, принимаются из них два, и
 * без перечисления человек не понимает, что именно менять при выгрузке:
 * `.odt`, `.rtf`, `.txt` и `.epub` отбивались текстом, из которого не видно
 * ни одного рабочего варианта.
 */
function build() {
  const controller = new ImportController(
    {} as any,
    {} as any,
    { getFileImportSizeLimit: () => '100mb' } as any,
    {} as any,
    {} as any,
  );
  jest.spyOn((controller as any).logger, 'error').mockImplementation(() => {});
  return controller;
}

/** Запрос в том объеме, в каком его читает контроллер до проверки расширения. */
function request(filename: string) {
  return {
    file: async () => ({ filename, fields: { spaceId: { value: 'sp-1' } } }),
  } as any;
}

describe('ImportController, отказ по расширению', () => {
  it.each(['.odt', '.rtf', '.txt', '.epub', '.xlsx'])(
    'формат %s отбивается с перечислением допустимых',
    async (ext) => {
      const controller = build();

      await expect(
        controller.importPage(
          request(`Исторические фильмы${ext}`),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Invalid import file type. Supported: .md, .html, .docx, .pdf.',
        ),
      );
    },
  );

  it('архив с чужим расширением тоже называет допустимые', async () => {
    const controller = build();

    await expect(
      controller.importZip(request('выгрузка.rar'), {} as any, {} as any),
    ).rejects.toThrow(/Supported: \.zip\./);
  });

  /**
   * Проверка расширения обязана оставаться первой: имя файла приходит от
   * человека, и дальше по методу идут обращения к зависимостям.
   */
  it('допустимое расширение проходит проверку дальше', async () => {
    const controller = build();

    await expect(
      controller.importPage(
        request('Исторические фильмы.docx'),
        {} as any,
        {} as any,
      ),
    ).rejects.not.toThrow(/Invalid import file type/);
  });
});
