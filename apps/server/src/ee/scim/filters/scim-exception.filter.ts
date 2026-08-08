import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { SCIM_CONTENT_TYPE, SCIM_SCHEMAS } from '../scim.constants';

/** Нарушение уникального ограничения в PostgreSQL. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Ошибки протокола в формате SCIM, а не в обычном конверте приложения.
 *
 * Провайдер разбирает тело по RFC 7644 и на `{message, error, statusCode}`
 * реагирует как на сбой транспорта: в его интерфейсе это выглядит как
 * «сервер недоступен», а не «токен отозван». Разница существенная, потому
 * что чинят эти два случая по-разному.
 *
 * Фильтр вешается только на контроллеры протокола: у остального приложения
 * формат ответа свой, и менять его нельзя.
 */
@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ScimExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();

    const status = this.statusOf(exception);

    const detail = this.detailOf(exception, status);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Необработанная ошибка SCIM: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
    }

    const body: Record<string, unknown> = {
      schemas: [SCIM_SCHEMAS.ERROR],
      // Поле строковое по спецификации, не числовое.
      status: String(status),
      detail,
    };

    const scimType = this.scimTypeOf(exception, status);
    if (scimType) body.scimType = scimType;

    response.status(status).type(SCIM_CONTENT_TYPE).send(body);
  }

  /**
   * Нарушение уникальности от базы это 409, а не 500.
   *
   * Проверки совпадения выполняются отдельным запросом до записи, и между
   * проверкой и вставкой есть окно: два одновременных запроса провайдера
   * пройдут обе проверки. Разница существенная, провайдер трактует 500 как
   * сбой сервера и повторяет запрос бесконечно, а 409 как свою ошибку в
   * данных. Тот же код приходит от строк, отфильтрованных по `deleted_at`:
   * частичный уникальный индекс про мягкое удаление не знает.
   */
  private statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    if ((exception as any)?.code === POSTGRES_UNIQUE_VIOLATION) {
      return HttpStatus.CONFLICT;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  /**
   * Наружу уходит только то, что провайдеру полезно. Внутренняя ошибка
   * описывается общо: ее текст может содержать детали устройства системы.
   */
  private detailOf(exception: unknown, status: number): string {
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return 'Internal server error';
    }

    // Текст ошибки базы наружу не идет: он содержит имена таблиц и колонок.
    if ((exception as any)?.code === POSTGRES_UNIQUE_VIOLATION) {
      return 'Resource already exists';
    }

    if (exception instanceof HttpException) {
      const payload = exception.getResponse() as any;
      if (typeof payload === 'string') return payload;
      if (Array.isArray(payload?.message)) return payload.message.join('; ');
      if (typeof payload?.message === 'string') return payload.message;
    }

    return 'Request failed';
  }

  /**
   * `scimType` определен спецификацией не для всех кодов. По таблице 9
   * RFC 7644 все значения кроме `uniqueness` относятся к 400; у 401, 403 и
   * 404 его нет, и подставлять туда выдуманное значение нельзя.
   *
   * Уточнение приходит из самой ошибки, если место возникновения его знает:
   * под 400 попадают и неподдерживаемый фильтр, и неверный путь изменения, и
   * недопустимое значение, а по коду ответа они неразличимы.
   */
  private scimTypeOf(exception: unknown, status: number): string | null {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse() as any;
      if (typeof payload?.scimType === 'string') return payload.scimType;
    }

    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'invalidValue';
      case HttpStatus.CONFLICT:
        return 'uniqueness';
      default:
        return null;
    }
  }
}
