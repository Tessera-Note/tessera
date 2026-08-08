import * as scimmy from 'scimmy';
import { SCIM_SCHEMAS } from './scim.constants';

/**
 * Атрибуты ресурса User, которые сервер действительно хранит и отдает.
 *
 * Ядро протокола описывает два десятка атрибутов, от `photos` до
 * `x509Certificates`. Объявить их все значило бы пообещать провайдеру
 * хранение того, чего в базе нет: он отправил бы значения, получил бы 200 и
 * счел бы их сохраненными, а при следующем сравнении увидел бы пустоту и
 * начал бы слать их снова на каждом цикле.
 */
const SUPPORTED_USER_ATTRIBUTES = [
  'userName',
  'name',
  'displayName',
  'active',
  'emails',
];

/**
 * Описание схемы User, урезанное до поддерживаемого.
 *
 * Типы, изменяемость и обязательность берутся у библиотеки, а не пишутся
 * заново: это те же определения, по которым разбирается PATCH, и расхождение
 * между объявленным и применяемым исключено по построению.
 */
export function describeUserSchema(location: string): Record<string, any> {
  const described = (scimmy as any).Schemas.User.definition.describe();

  return {
    ...described,
    attributes: described.attributes.filter((attribute: any) =>
      SUPPORTED_USER_ATTRIBUTES.includes(attribute.name),
    ),
    meta: {
      resourceType: 'Schema',
      location,
    },
  };
}

/**
 * Атрибуты ресурса Group, которые сервер действительно хранит.
 *
 * У ядра их всего два, и оба поддержаны. `description` в схему группы по
 * RFC 7643 не входит вовсе, хотя колонка в базе есть: объявить его значило
 * бы расширить стандартную схему собственным атрибутом, а провайдер о нем
 * не знает.
 */
const SUPPORTED_GROUP_ATTRIBUTES = ['displayName', 'members'];

export function describeGroupSchema(location: string): Record<string, any> {
  const described = (scimmy as any).Schemas.Group.definition.describe();

  return {
    ...described,
    attributes: described.attributes.filter((attribute: any) =>
      SUPPORTED_GROUP_ATTRIBUTES.includes(attribute.name),
    ),
    meta: {
      resourceType: 'Schema',
      location,
    },
  };
}

export function describeGroupResourceType(
  location: string,
  endpoint: string,
): Record<string, any> {
  return {
    schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
    id: 'Group',
    name: 'Group',
    endpoint,
    description: 'Group',
    schema: SCIM_SCHEMAS.GROUP,
    meta: {
      resourceType: 'ResourceType',
      location,
    },
  };
}

export function describeUserResourceType(
  location: string,
  endpoint: string,
): Record<string, any> {
  return {
    schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
    id: 'User',
    name: 'User',
    endpoint,
    description: 'User Account',
    schema: SCIM_SCHEMAS.USER,
    meta: {
      resourceType: 'ResourceType',
      location,
    },
  };
}
