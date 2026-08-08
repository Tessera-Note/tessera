import { ScimController } from './scim.controller';
import { SCIM_MAX_RESULTS, SCIM_SCHEMAS } from './scim.constants';

/**
 * Документы обнаружения провайдер читает первыми и строит по ним запросы.
 * Расхождение между объявленным и реализованным он обнаруживает уже на
 * рабочих данных, поэтому совпадение проверяется тестом, а не глазами.
 */
function build() {
  const environmentService: any = {
    getAppUrl: () => 'https://wiki.tessera.com',
  };
  return new ScimController(environmentService);
}

describe('ScimController, ServiceProviderConfig', () => {
  it('объявлено то, что реализовано', () => {
    const config: any = build().serviceProviderConfig();

    expect(config.patch.supported).toBe(true);
    expect(config.filter.supported).toBe(true);
    expect(config.bulk.supported).toBe(false);
    expect(config.changePassword.supported).toBe(false);
    expect(config.sort.supported).toBe(false);
    expect(config.etag.supported).toBe(false);
  });

  // По этому числу провайдер решает, дочитал ли он список до конца.
  it('объявленный предел выдачи совпадает с применяемым', () => {
    expect(build().serviceProviderConfig().filter.maxResults).toBe(
      SCIM_MAX_RESULTS,
    );
  });

  it('схема аутентификации одна, токен Bearer', () => {
    const schemes = build().serviceProviderConfig().authenticationSchemes;

    expect(schemes).toHaveLength(1);
    expect(schemes[0].type).toBe('oauthbearertoken');
  });
});

describe('ScimController, ResourceTypes', () => {
  it('перечислены оба реализованных ресурса', () => {
    const list: any = build().resourceTypes();

    expect(list.schemas).toEqual([SCIM_SCHEMAS.LIST_RESPONSE]);
    expect(list.totalResults).toBe(2);
    expect(list.Resources.map((r: any) => r.id)).toEqual(['User', 'Group']);
  });

  it('пути ресурсов относительные, как требует RFC 7643', () => {
    const [user, group]: any = build().resourceTypes().Resources;

    expect(user.endpoint).toBe('/Users');
    expect(user.schema).toBe(SCIM_SCHEMAS.USER);
    expect(user.meta.location).toBe(
      'https://wiki.tessera.com/api/scim/v2/ResourceTypes/User',
    );

    expect(group.endpoint).toBe('/Groups');
    expect(group.schema).toBe(SCIM_SCHEMAS.GROUP);
    expect(group.meta.location).toBe(
      'https://wiki.tessera.com/api/scim/v2/ResourceTypes/Group',
    );
  });
});

describe('ScimController, Schemas', () => {
  it('описаны схемы обоих ресурсов', () => {
    const list: any = build().schemas();

    expect(list.totalResults).toBe(2);
    expect(list.Resources.map((r: any) => r.id)).toEqual([
      SCIM_SCHEMAS.USER,
      SCIM_SCHEMAS.GROUP,
    ]);
  });

  /**
   * Атрибут, объявленный и не сохраняемый, провайдер будет слать на каждом
   * цикле: он получит 200, при следующем сравнении увидит пустоту и повторит.
   */
  it('объявлены только те атрибуты, которые сервер действительно хранит', () => {
    const [schema]: any = build().schemas().Resources;
    const names = schema.attributes.map((a: any) => a.name).sort();

    expect(names).toEqual([
      'active',
      'displayName',
      'emails',
      'name',
      'userName',
    ]);
  });

  /**
   * У схемы группы в ядре всего два атрибута, и оба поддержаны. `description`
   * в схему по RFC 7643 не входит, хотя колонка в базе есть.
   */
  it('в схеме группы объявлены только хранимые атрибуты', () => {
    const [, group]: any = build().schemas().Resources;
    const names = group.attributes.map((a: any) => a.name).sort();

    expect(names).toEqual(['displayName', 'members']);
  });

  it('пароль и прочее нереализованное не объявлено', () => {
    const [schema]: any = build().schemas().Resources;
    const names = schema.attributes.map((a: any) => a.name);

    for (const absent of [
      'password',
      'phoneNumbers',
      'photos',
      'addresses',
      'groups',
      'roles',
      'x509Certificates',
    ]) {
      expect(names).not.toContain(absent);
    }
  });
});
