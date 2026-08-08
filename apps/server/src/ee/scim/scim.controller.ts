import { Controller, Get, Header, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import { ScimExceptionFilter } from './filters/scim-exception.filter';
import {
  SCIM_BASE_PATH,
  SCIM_CONTENT_TYPE,
  SCIM_MAX_RESULTS,
  SCIM_SCHEMAS,
} from './scim.constants';
import {
  describeGroupResourceType,
  describeGroupSchema,
  describeUserResourceType,
  describeUserSchema,
} from './scim-schema.util';

/**
 * Точки обнаружения протокола SCIM.
 *
 * Провайдер опрашивает их первыми, до всякой синхронизации, чтобы понять,
 * что сервер умеет. Отвечать они обязаны в формате SCIM даже при отказе:
 * обычный конверт приложения провайдер трактует как сбой транспорта.
 *
 * `@Public()` снимает проверку сессии, но не проверку доступа: за нее
 * отвечает `ScimAuthGuard`, аутентифицирующий по токену.
 *
 * `@SkipTransform()` обязателен на каждом обработчике: тела ответов заданы
 * спецификацией и не переживут оборачивания в `{data, success, status}`.
 * Тип ответа `application/scim+json` обязателен по RFC 7644 3.1.
 */
@UseFilters(ScimExceptionFilter)
@UseGuards(ScimAuthGuard)
@Controller(SCIM_BASE_PATH)
export class ScimController {
  constructor(private readonly environmentService: EnvironmentService) {}

  private location(path: string): string {
    return `${this.environmentService.getAppUrl()}/api/${SCIM_BASE_PATH}${path}`;
  }

  /**
   * Возможности сервера.
   *
   * Объявляется ровно то, что реализовано. Частичное изменение и фильтрация
   * появились вместе с ресурсом User. Массовые операции, смена пароля и
   * сортировка не реализованы и объявлены выключенными: объявить их значит
   * заставить провайдера строить запросы, на которые сервер ответить не
   * сможет.
   *
   * `filter.maxResults` совпадает с пределом выдачи в `ScimUserService`.
   * Разойтись им нельзя: провайдер по этому числу решает, дочитал ли он
   * список до конца.
   */
  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @Get('ServiceProviderConfig')
  serviceProviderConfig() {
    return {
      schemas: [SCIM_SCHEMAS.SERVICE_PROVIDER_CONFIG],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description:
            'Authentication scheme using the OAuth Bearer Token Standard',
          primary: true,
        },
      ],
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: this.location('/ServiceProviderConfig'),
      },
    };
  }

  /**
   * Типы ресурсов.
   *
   * Перечисляется ровно то, у чего есть маршруты. Объявленный, но не
   * реализованный ресурс хуже необъявленного: провайдер начнет слать
   * запросы, на которые сервер ответит 404.
   */
  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @Get('ResourceTypes')
  resourceTypes() {
    return this.list([
      // Путь относительный к базовому адресу протокола, как требует
      // RFC 7643: полный адрес провайдер собирает сам.
      describeUserResourceType(this.location('/ResourceTypes/User'), '/Users'),
      describeGroupResourceType(
        this.location('/ResourceTypes/Group'),
        '/Groups',
      ),
    ]);
  }

  /** Описания схем. Появляются вместе с ресурсами. */
  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @Get('Schemas')
  schemas() {
    return this.list([
      describeUserSchema(this.location(`/Schemas/${SCIM_SCHEMAS.USER}`)),
      describeGroupSchema(this.location(`/Schemas/${SCIM_SCHEMAS.GROUP}`)),
    ]);
  }

  private list(resources: Record<string, any>[]) {
    return {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }
}
