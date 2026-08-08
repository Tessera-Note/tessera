/** Базовый путь протокола. Клиент показывает его администратору как есть. */
export const SCIM_BASE_PATH = 'scim/v2';

/**
 * Предел выдачи за один запрос списка.
 *
 * Одно значение на весь протокол: оно объявляется в `ServiceProviderConfig`
 * и применяется в сервисе. Разойтись им нельзя, по этому числу провайдер
 * решает, дочитал ли он список до конца.
 */
export const SCIM_MAX_RESULTS = 200;

/** Размер страницы, когда провайдер не указал `count`. */
export const SCIM_DEFAULT_COUNT = 100;

/** Тип содержимого по RFC 7644. Разбор входящего уже настроен в main.ts. */
export const SCIM_CONTENT_TYPE = 'application/scim+json';

export const SCIM_SCHEMAS = {
  ERROR: 'urn:ietf:params:scim:api:messages:2.0:Error',
  LIST_RESPONSE: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  SERVICE_PROVIDER_CONFIG:
    'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  USER: 'urn:ietf:params:scim:schemas:core:2.0:User',
  GROUP: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  RESOURCE_TYPE: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
} as const;
