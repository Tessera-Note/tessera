import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ScimExceptionFilter } from './scim-exception.filter';
import { SCIM_CONTENT_TYPE, SCIM_SCHEMAS } from '../scim.constants';
import { ScimException } from '../scim.exception';

/**
 * Провайдер разбирает тело ошибки по RFC 7644. Обычный конверт приложения
 * он трактует как сбой транспорта, то есть «сервер недоступен» вместо
 * «токен отозван», а чинят эти два случая по-разному.
 */
function run(exception: unknown) {
  const sent: any = {};
  const response: any = {
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    type: (value: string) => {
      sent.type = value;
      return response;
    },
    send: (body: any) => {
      sent.body = body;
      return response;
    },
  };
  const host: any = { switchToHttp: () => ({ getResponse: () => response }) };

  const filter = new ScimExceptionFilter();
  jest.spyOn((filter as any).logger, 'error').mockImplementation(() => {});
  filter.catch(exception, host);

  return sent;
}

describe('ScimExceptionFilter, формат', () => {
  it('тело содержит схему ошибки SCIM', () => {
    const sent = run(new UnauthorizedException('Invalid SCIM token'));

    expect(sent.body.schemas).toEqual([SCIM_SCHEMAS.ERROR]);
  });

  it('тип содержимого протокольный, а не обычный json', () => {
    expect(run(new UnauthorizedException()).type).toBe(SCIM_CONTENT_TYPE);
  });

  // По спецификации поле строковое, а не числовое.
  it('код состояния передается строкой', () => {
    const sent = run(new NotFoundException());

    expect(sent.status).toBe(404);
    expect(sent.body.status).toBe('404');
  });

  it('в теле нет полей обычного конверта приложения', () => {
    const sent = run(new BadRequestException('плохо'));

    expect(sent.body.success).toBeUndefined();
    expect(sent.body.error).toBeUndefined();
    expect(sent.body.statusCode).toBeUndefined();
  });

  it('сообщение попадает в detail', () => {
    expect(
      run(new UnauthorizedException('Invalid SCIM token')).body.detail,
    ).toBe('Invalid SCIM token');
  });
});

describe('ScimExceptionFilter, scimType', () => {
  it('400 получает invalidValue', () => {
    expect(run(new BadRequestException()).body.scimType).toBe('invalidValue');
  });

  it('409 получает uniqueness', () => {
    expect(run(new ConflictException()).body.scimType).toBe('uniqueness');
  });

  /**
   * По таблице 9 RFC 7644 все значения кроме `uniqueness` относятся к 400.
   * У 401, 403 и 404 спецификация scimType не определяет, выдумывать нельзя.
   */
  it('401, 403 и 404 идут без scimType', () => {
    expect(run(new UnauthorizedException()).body.scimType).toBeUndefined();
    expect(run(new ForbiddenException()).body.scimType).toBeUndefined();
    expect(run(new NotFoundException()).body.scimType).toBeUndefined();
  });

  /**
   * Под 400 попадают и неподдерживаемый фильтр, и неверный путь изменения,
   * и недопустимое значение. По коду ответа они неразличимы, поэтому место
   * возникновения может уточнить причину само.
   */
  it('явное уточнение из ошибки перекрывает значение по умолчанию', () => {
    expect(
      run(new ScimException(400, 'плохой фильтр', 'invalidFilter')).body
        .scimType,
    ).toBe('invalidFilter');
  });

  it('уточнение доступно и на кодах, где значения по умолчанию нет', () => {
    expect(
      run(new ScimException(404, 'нет цели', 'noTarget')).body.scimType,
    ).toBe('noTarget');
  });
});

/**
 * Проверки совпадения идут отдельным запросом до записи, и между ними есть
 * окно. Провайдер трактует 500 как сбой сервера и повторяет запрос
 * бесконечно, а 409 как свою ошибку в данных.
 */
describe('ScimExceptionFilter, нарушение уникальности от базы', () => {
  const uniqueViolation = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "idx_users_workspace_scim_external_id"',
    ),
    { code: '23505' },
  );

  it('код 23505 дает 409, а не 500', () => {
    const sent = run(uniqueViolation);

    expect(sent.status).toBe(409);
    expect(sent.body.status).toBe('409');
    expect(sent.body.scimType).toBe('uniqueness');
  });

  it('имена таблиц и колонок наружу не уходят', () => {
    expect(run(uniqueViolation).body.detail).toBe('Resource already exists');
  });

  it('другой код базы остается пятисотой ошибкой', () => {
    const sent = run(Object.assign(new Error('нет связи'), { code: '08006' }));

    expect(sent.status).toBe(500);
    expect(sent.body.detail).toBe('Internal server error');
  });
});

describe('ScimExceptionFilter, внутренняя ошибка', () => {
  it('произвольное исключение дает 500 и общий текст', () => {
    const sent = run(new Error('соединение с базой оборвано на шарде 3'));

    expect(sent.status).toBe(500);
    expect(sent.body.status).toBe('500');
    // Текст внутренней ошибки наружу не уходит: он описывает устройство системы.
    expect(sent.body.detail).toBe('Internal server error');
    expect(JSON.stringify(sent.body)).not.toContain('шарде');
  });
});
