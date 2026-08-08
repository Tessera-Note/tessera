import { HttpException } from '@nestjs/common';

/**
 * Ошибка протокола с явным `scimType`.
 *
 * RFC 7644 определяет `scimType` не как функцию кода ответа: под 400 попадают
 * `invalidFilter`, `invalidSyntax`, `invalidPath`, `mutability` и другие,
 * различить которые может только место возникновения. Выводить значение из
 * одного лишь кода значит всегда отдавать провайдеру одну и ту же причину.
 */
export class ScimException extends HttpException {
  constructor(
    status: number,
    detail: string,
    readonly scimType?: string,
  ) {
    super({ message: detail, scimType }, status);
  }
}
