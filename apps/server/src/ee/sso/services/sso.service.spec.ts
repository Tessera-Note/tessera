import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SsoService } from './sso.service';
import WorkspaceAbilityFactory from '../../../core/casl/abilities/workspace-ability.factory';
import { UserRole } from '../../../common/helpers/types/permission';

const WORKSPACE = { id: 'ws-1' } as any;
const actorWith = (role: string) => ({ id: 'actor-1', role }) as any;

const OIDC = {
  id: 'prov-1',
  type: 'oidc',
  name: 'Корпоративный вход',
  oidcIssuer: 'https://idp.example.com',
  oidcClientId: 'client',
  oidcClientSecret: 'v1:зашифровано',
  ldapBindPassword: null,
  workspaceId: 'ws-1',
};

function build(
  options: {
    existing?: any;
    rows?: any[];
    updated?: number;
    target?: any;
  } = {},
) {
  const inserted: any[] = [];
  const updates: any[] = [];

  const selectChain: any = {
    selectAll: () => selectChain,
    select: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    execute: async () => options.rows ?? [],
    executeTakeFirst: async () =>
      'existing' in options ? options.existing : OIDC,
  };

  const db: any = {
    selectFrom: () => selectChain,
    insertInto: () => ({
      values: (v: any) => {
        inserted.push(v);
        return {
          returningAll: () => ({
            executeTakeFirst: async () => ({ ...v, id: 'new-1' }),
          }),
        };
      },
    }),
    updateTable: () => {
      const upd: any = {
        set: (v: any) => {
          updates.push(v);
          return upd;
        },
        where: () => upd,
        returningAll: () => ({
          executeTakeFirst: async () => ({ ...OIDC, ...updates[0] }),
        }),
        executeTakeFirst: async () => ({
          numUpdatedRows: BigInt(options.updated ?? 1),
        }),
      };
      return upd;
    },
  };

  const userRepo: any = {
    findById: jest.fn(async () =>
      'target' in options ? options.target : { id: 'user-7', email: 'u@x.com' },
    ),
  };
  const auditService: any = { log: jest.fn(), setActorId: jest.fn() };

  const service = new SsoService(
    db,
    { getAppSecret: () => 'секрет-приложения' } as any,
    new WorkspaceAbilityFactory(),
    userRepo,
    auditService,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
  return { service, inserted, updates, userRepo, auditService };
}

describe('SsoService, права', () => {
  it.each([[UserRole.OWNER], [UserRole.ADMIN]])(
    'роль %s управляет провайдерами',
    async (role) => {
      const { service } = build({ rows: [] });

      await expect(
        service.list(actorWith(role), WORKSPACE),
      ).resolves.toMatchObject({ items: [] });
    },
  );

  it('участник не читает список', async () => {
    const { service } = build({ rows: [] });

    await expect(
      service.list(actorWith(UserRole.MEMBER), WORKSPACE),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('участник не заводит провайдера', async () => {
    const { service, inserted } = build();

    await expect(
      service.create(
        { name: 'x', type: 'oidc' } as any,
        actorWith(UserRole.MEMBER),
        WORKSPACE,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(inserted).toHaveLength(0);
  });
});

/**
 * Секреты хранятся шифрованными и наружу не отдаются: в отличие от ключа
 * провайдера ИИ, где маскированный превью помогает опознать ключ, здесь
 * опознавать нечего.
 */
describe('SsoService, секреты', () => {
  it('секрет шифруется перед записью', async () => {
    const { service, inserted } = build();

    await service.create(
      {
        name: 'Вход',
        type: 'oidc',
        oidcIssuer: 'https://idp',
        oidcClientId: 'id',
        oidcClientSecret: 'открытый-секрет',
      } as any,
      actorWith(UserRole.ADMIN),
      WORKSPACE,
    );

    expect(inserted[0].oidcClientSecret).not.toBe('открытый-секрет');
    expect(inserted[0].oidcClientSecret).toMatch(/^v1:/);
  });

  it('наружу отдается только признак заполненности', async () => {
    const { service } = build();

    const result: any = await service.findById(
      'prov-1',
      actorWith(UserRole.ADMIN),
      WORKSPACE,
    );

    expect(result.oidcClientSecret).toBeUndefined();
    expect(result.oidcClientSecretSet).toBe(true);
    expect(result.ldapBindPasswordSet).toBe(false);
  });

  it('список тоже без секретов', async () => {
    const { service } = build({ rows: [OIDC] });

    const result: any = await service.list(
      actorWith(UserRole.ADMIN),
      WORKSPACE,
    );

    expect(result.items[0].oidcClientSecret).toBeUndefined();
    expect(result.items[0].oidcClientSecretSet).toBe(true);
  });

  // Форма не показывает текущее значение, отправка без ввода не должна
  // обнулять секрет.
  it('пустой секрет при изменении не стирает прежний', async () => {
    const { service, updates } = build();

    await service.update(
      { providerId: 'prov-1', oidcClientSecret: '' } as any,
      actorWith(UserRole.ADMIN),
      WORKSPACE,
    );

    expect(updates[0].oidcClientSecret).toBeUndefined();
  });
});

describe('SsoService, обязательные поля по типу', () => {
  const create = (service: SsoService, dto: any) =>
    service.create(dto, actorWith(UserRole.ADMIN), WORKSPACE);

  it.each([
    ['saml', { samlUrl: 'https://idp', samlCertificate: 'cert' }],
    [
      'oidc',
      { oidcIssuer: 'https://idp', oidcClientId: 'id', oidcClientSecret: 's' },
    ],
    ['ldap', { ldapUrl: 'ldaps://x', ldapBaseDn: 'dc=x' }],
    ['google', {}],
  ])('тип %s с полными полями принимается', async (type, fields) => {
    const { service } = build();

    await expect(
      create(service, { name: 'Вход', type, ...fields }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['saml', { samlUrl: 'https://idp' }, 'samlCertificate'],
    ['oidc', { oidcIssuer: 'https://idp' }, 'oidcClientId'],
    ['ldap', { ldapUrl: 'ldaps://x' }, 'ldapBaseDn'],
  ])('тип %s без поля %s отвергается', async (type, fields, _missing) => {
    const { service, inserted } = build();

    await expect(
      create(service, { name: 'Вход', type, ...fields }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inserted).toHaveLength(0);
  });

  it('неизвестный тип отвергается', async () => {
    const { service } = build();

    await expect(
      create(service, { name: 'Вход', type: 'неизвестный' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SsoService, заведение и изменение', () => {
  // Ошибка в адресе или сертификате у включенного провайдера сразу
  // перекрыла бы вход всем, кто идет через SSO.
  it('новый провайдер по умолчанию выключен', async () => {
    const { service, inserted } = build();

    await service.create(
      { name: 'Вход', type: 'google' } as any,
      actorWith(UserRole.ADMIN),
      WORKSPACE,
    );

    expect(inserted[0].isEnabled).toBe(false);
  });

  it('явное включение уважается', async () => {
    const { service, inserted } = build();

    await service.create(
      { name: 'Вход', type: 'google', isEnabled: true } as any,
      actorWith(UserRole.ADMIN),
      WORKSPACE,
    );

    expect(inserted[0].isEnabled).toBe(true);
  });

  // Поля разных типов не пересекаются, смена типа оставила бы провайдера
  // с заполненными полями от прежнего протокола.
  it('тип изменить нельзя', async () => {
    const { service, updates } = build();

    await service.update(
      { providerId: 'prov-1', type: 'saml' } as any,
      actorWith(UserRole.ADMIN),
      WORKSPACE,
    );

    expect(updates[0].type).toBeUndefined();
  });

  it('изменение несуществующего дает 404', async () => {
    const { service } = build({ existing: undefined });

    await expect(
      service.update(
        { providerId: 'нет' } as any,
        actorWith(UserRole.ADMIN),
        WORKSPACE,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('изменение, ломающее обязательные поля, отвергается', async () => {
    const { service } = build();

    await expect(
      service.update(
        { providerId: 'prov-1', oidcClientId: '' } as any,
        actorWith(UserRole.ADMIN),
        WORKSPACE,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SsoService, удаление', () => {
  // На провайдера ссылаются auth_accounts, физическое удаление разорвало бы
  // связь пользователей с их учетными записями у провайдера.
  it('удаление мягкое и выключает провайдера', async () => {
    const { service, updates } = build();

    await service.delete('prov-1', actorWith(UserRole.ADMIN), WORKSPACE);

    expect(updates[0].deletedAt).toBeInstanceOf(Date);
    expect(updates[0].isEnabled).toBe(false);
  });

  it('удаление несуществующего дает 404', async () => {
    const { service } = build({ updated: 0 });

    await expect(
      service.delete('нет', actorWith(UserRole.ADMIN), WORKSPACE),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('участник не удаляет', async () => {
    const { service, updates } = build();

    await expect(
      service.delete('prov-1', actorWith(UserRole.MEMBER), WORKSPACE),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(updates).toHaveLength(0);
  });
});

/**
 * Сверка APP_URL с адресом, по которому открыт интерфейс.
 *
 * Адреса протокола сервер строит от APP_URL, а значения для копирования
 * в провайдера экран настройки показывает от адреса открытой страницы.
 * Расхождение отвергает каждый вход, поэтому ловится в момент настройки.
 */
describe('SsoService, сверка APP_URL', () => {
  const check = (type: string, origin?: string) =>
    (
      new SsoService(
        {} as any,
        { getAppUrl: () => 'https://wiki.local' } as any,
        {} as any,
        {} as any,
        {} as any,
      ) as any
    ).checkAppUrl(type, origin);

  it('совпадение не дает предупреждения', () => {
    expect(check('oidc', 'https://wiki.local')).toBeNull();
  });

  it('хвостовая косая и регистр не считаются расхождением', () => {
    expect(check('saml', 'https://WIKI.local/')).toBeNull();
  });

  it('расхождение возвращает оба адреса', () => {
    expect(check('saml', 'https://other.local')).toEqual({
      appUrl: 'https://wiki.local',
      origin: 'https://other.local',
    });
  });

  // У LDAP обращение идет к каталогу напрямую, у Google адрес общий.
  it('типы, не зависящие от APP_URL, не сверяются', () => {
    expect(check('ldap', 'https://other.local')).toBeNull();
    expect(check('google', 'https://other.local')).toBeNull();
  });

  it('без адреса интерфейса сверка не делается', () => {
    expect(check('oidc', undefined)).toBeNull();
  });
});

/**
 * Снятие связи участника с провайдерами входа.
 *
 * Единственный выход из тупика, когда провайдер сменил идентификатор
 * человека: вход в этом случае отвергается намеренно, а перепривязать
 * автоматически нельзя.
 */
describe('SsoService, снятие связи с провайдером', () => {
  const OWNER = { id: 'owner-1', role: 'owner' } as any;
  const MEMBER = { id: 'member-1', role: 'member' } as any;
  const WORKSPACE = { id: 'ws-1' } as any;

  it('связи помечаются удаленными, а не стираются', async () => {
    const { service, updates } = build({ updated: 2 });

    await expect(
      service.unlinkUser('user-7', OWNER, WORKSPACE),
    ).resolves.toEqual({ success: true, unlinked: 2 });

    expect(updates[0]).toEqual(
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it('пишется отдельное событие журнала', async () => {
    const { service, auditService } = build({ updated: 1 });

    await service.unlinkUser('user-7', OWNER, WORKSPACE);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.sso_unlinked',
        resourceType: 'user',
        resourceId: 'user-7',
        metadata: { unlinked: 1 },
      }),
    );
  });

  it('участнику без прав администратора отказано', async () => {
    const { service, auditService } = build({ updated: 1 });

    await expect(
      service.unlinkUser('user-7', MEMBER, WORKSPACE),
    ).rejects.toThrow(ForbiddenException);

    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('неизвестный пользователь дает понятный отказ', async () => {
    const { service } = build({ updated: 1, target: undefined });

    await expect(
      service.unlinkUser('нет-такого', OWNER, WORKSPACE),
    ).rejects.toMatchObject({ response: { code: 'error.sso.user_not_found' } });
  });

  // Без связей действие бессмысленно, и молчаливый успех вводил бы в
  // заблуждение: администратор решил бы, что тупик разобран.
  it('отсутствие связей дает отказ, а не молчаливый успех', async () => {
    const { service, auditService } = build({ updated: 0 });

    await expect(
      service.unlinkUser('user-7', OWNER, WORKSPACE),
    ).rejects.toMatchObject({
      response: { code: 'error.sso.user_has_no_links' },
    });

    expect(auditService.log).not.toHaveBeenCalled();
  });
});
