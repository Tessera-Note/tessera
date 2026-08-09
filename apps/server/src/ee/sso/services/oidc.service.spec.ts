import * as openidClient from 'openid-client';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { OidcService } from './oidc.service';
import { SsoIdentityService } from './sso-identity.service';

jest.mock('openid-client', () => ({
  discovery: jest.fn(async () => ({ настройка: true })),
  randomPKCECodeVerifier: () => 'проверочное-значение',
  calculatePKCECodeChallenge: async () => 'вызов',
  randomState: () => 'состояние-1',
  buildAuthorizationUrl: jest.fn(
    () => new URL('https://idp.example.com/authorize?state=состояние-1'),
  ),
  authorizationCodeGrant: jest.fn(),
  fetchUserInfo: jest.fn(),
  allowInsecureRequests: 'послабление',
}));

jest.mock('../../ai/ai-secret.util', () => ({
  decryptSecret: jest.fn((v: string | null) => (v ? 'секрет' : null)),
}));

// Модуль подменен фабрикой выше, поэтому настоящий ESM сюда не грузится
// и обычный импорт безопасен.
const client = openidClient as any;

const WORKSPACE = { id: 'ws-1' } as any;
const PROVIDER = {
  id: 'prov-1',
  type: 'oidc',
  isEnabled: true,
  oidcIssuer: 'https://idp.example.com',
  oidcClientId: 'tessera',
  oidcClientSecret: 'v1:шифр',
  allowSignup: false,
  workspaceId: 'ws-1',
};

function build(
  options: {
    provider?: any;
    linked?: any;
    existingUser?: any;
    claims?: any;
    isHttps?: boolean;
  } = {},
) {
  const inserted: any[] = [];

  const makeChain = (table: string): any => {
    const chain: any = {
      selectAll: () => chain,
      select: () => chain,
      where: () => chain,
      executeTakeFirst: async () => {
        if (table === 'authProviders')
          return 'provider' in options ? options.provider : PROVIDER;
        if (table === 'authAccounts')
          return 'linked' in options ? options.linked : undefined;
        return undefined;
      },
    };
    return chain;
  };

  const db: any = {
    selectFrom: (table: string) => makeChain(table),
    insertInto: (table: string) => ({
      values: (v: any) => {
        const entry: any = { table, values: v, conflict: null };
        inserted.push(entry);
        // Мок повторяет форму настоящего построителя: привязка учетной записи
        // идет через onConflict, и без него мок молча расходится с кодом.
        const builder: any = {
          execute: async () => [],
          onConflict: (cb: (oc: any) => unknown) => {
            cb({
              columns: (columns: string[]) => ({
                doUpdateSet: (set: any) => {
                  entry.conflict = { columns, set };
                  return {};
                },
              }),
            });
            return builder;
          },
        };
        return builder;
      },
    }),
    transaction: () => ({
      execute: async (cb: (trx: any) => Promise<unknown>) => cb(db),
    }),
  };

  const userRepo: any = {
    findById: jest.fn(async () => ({ id: 'user-1', email: 'u@example.com' })),
    findByEmail: jest.fn(async () =>
      'existingUser' in options ? options.existingUser : undefined,
    ),
    insertUser: jest.fn(async (u: any) => ({ ...u, id: 'new-user' })),
    updateLastLogin: jest.fn(async () => undefined),
  };

  const auditService: any = { log: jest.fn(), setActorId: jest.fn() };

  const workspaceService: any = { addUserToWorkspace: jest.fn() };
  const sessionService: any = {
    createSessionAndToken: jest.fn(async () => 'сессия'),
  };

  // Общая часть входа собирается настоящей, а не подменяется: проверки этой
  // спеки описывают поведение всего пути, а не одного протокола.
  const ssoIdentity = new SsoIdentityService(
    db,
    userRepo,
    { addUserToDefaultGroup: jest.fn() } as any,
    workspaceService,
    // Синхронизация групп в этих проверках не участвует.
    { sync: jest.fn(async () => {}) } as any,
  );
  jest.spyOn((ssoIdentity as any).logger, 'log').mockImplementation(() => {});

  const service = new OidcService(
    userRepo,
    sessionService,
    {
      getAppSecret: () => 'секрет',
      getAppUrl: () => 'https://wiki.local',
      isHttps: () => options.isHttps ?? false,
    } as any,
    ssoIdentity,
    auditService,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  return {
    service,
    inserted,
    userRepo,
    workspaceService,
    auditService,
    sessionService,
  };
}

const grantWith = (claims: any, accessToken = 'токен') => {
  client.authorizationCodeGrant.mockResolvedValue({
    claims: () => claims,
    access_token: accessToken,
  });
};

const FLOW = {
  providerId: 'prov-1',
  state: 'состояние-1',
  codeVerifier: 'проверочное-значение',
};

afterEach(() => jest.clearAllMocks());

describe('OidcService, начало входа', () => {
  it('строится адрес провайдера и состояние потока', async () => {
    const { service } = build();

    const result = await service.buildLoginRedirect('prov-1', WORKSPACE);

    expect(result.url).toContain('https://idp.example.com/authorize');
    expect(result.flow).toMatchObject({
      providerId: 'prov-1',
      state: 'состояние-1',
      codeVerifier: 'проверочное-значение',
    });
  });

  // Код авторизации уходит через браузер пользователя, перехваченный код
  // без проверочного значения дал бы вход.
  it('PKCE применяется всегда', async () => {
    const { service } = build();

    await service.buildLoginRedirect('prov-1', WORKSPACE);

    const params = client.buildAuthorizationUrl.mock.calls[0][1];
    expect(params.code_challenge).toBe('вызов');
    expect(params.code_challenge_method).toBe('S256');
  });

  it('точка возврата ведет на этот же провайдер', async () => {
    const { service } = build();

    await service.buildLoginRedirect('prov-1', WORKSPACE);

    expect(client.buildAuthorizationUrl.mock.calls[0][1].redirect_uri).toBe(
      'https://wiki.local/api/sso/oidc/prov-1/callback',
    );
  });

  it('выключенный или чужой провайдер отвергается', async () => {
    const { service } = build({ provider: undefined });

    await expect(
      service.buildLoginRedirect('prov-1', WORKSPACE),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('провайдер без секрета отвергается', async () => {
    const { service } = build({
      provider: { ...PROVIDER, oidcClientSecret: null },
    });

    await expect(
      service.buildLoginRedirect('prov-1', WORKSPACE),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // Устаревшая настройка отправляла бы людей к прежнему провайдеру.
  it('настройки провайдера читаются на каждый вход', async () => {
    const { service } = build();

    await service.buildLoginRedirect('prov-1', WORKSPACE);
    await service.buildLoginRedirect('prov-1', WORKSPACE);

    expect(client.discovery).toHaveBeenCalledTimes(2);
  });
});

describe('OidcService, обратный вызов', () => {
  const callback = (service: OidcService, flow: any = FLOW) =>
    service.handleCallback(
      'prov-1',
      'https://wiki.local/api/sso/oidc/prov-1/callback?code=x&state=состояние-1',
      flow,
      WORKSPACE,
    );

  // Без сверки состояния чужой обратный вызов входил бы в чужую запись.
  it('без состояния потока вход отвергается', async () => {
    const { service } = build();

    await expect(callback(service, null)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('состояние от другого провайдера отвергается', async () => {
    const { service } = build();

    await expect(
      callback(service, { ...FLOW, providerId: 'другой' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('проверочное значение передается провайдеру', async () => {
    const { service } = build({ linked: { userId: 'user-1' } });
    grantWith({ sub: 'внешний-1', email: 'u@example.com' });

    await callback(service);

    expect(client.authorizationCodeGrant.mock.calls[0][2]).toEqual({
      pkceCodeVerifier: 'проверочное-значение',
      expectedState: 'состояние-1',
    });
  });

  it('отказ провайдера дает отказ входа', async () => {
    const { service } = build();
    client.authorizationCodeGrant.mockRejectedValue(new Error('неверный код'));

    await expect(callback(service)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('без идентификатора пользователя вход отвергается', async () => {
    const { service } = build();
    grantWith({ email: 'u@example.com' });

    await expect(callback(service)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  // Часть провайдеров не кладет почту в токен.
  it('почта запрашивается отдельно, если ее нет в токене', async () => {
    const { service } = build({ linked: { userId: 'user-1' } });
    grantWith({ sub: 'внешний-1' });
    client.fetchUserInfo.mockResolvedValue({ email: 'u@example.com' });

    await expect(callback(service)).resolves.toMatchObject({
      authToken: 'сессия',
    });
    expect(client.fetchUserInfo).toHaveBeenCalled();
  });

  it('без почты вовсе вход отвергается', async () => {
    const { service } = build();
    grantWith({ sub: 'внешний-1' });
    client.fetchUserInfo.mockResolvedValue({});

    await expect(callback(service)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('OidcService, привязка учетной записи', () => {
  const callback = (service: OidcService) =>
    service.handleCallback(
      'prov-1',
      'https://wiki.local/cb?code=x',
      FLOW,
      WORKSPACE,
    );

  // Связь первична: почта у провайдера может смениться, идентификатор нет.
  it('связанный пользователь находится по идентификатору провайдера', async () => {
    const { service, userRepo } = build({ linked: { userId: 'user-1' } });
    grantWith({ sub: 'внешний-1', email: 'другая@example.com' });

    await callback(service);

    expect(userRepo.findById).toHaveBeenCalledWith('user-1', 'ws-1');
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
  });

  // Первый вход человека, уже заведенного в пространстве обычным способом.
  it('существующий по почте привязывается к провайдеру', async () => {
    const { service, inserted } = build({
      existingUser: { id: 'user-2', email: 'u@example.com' },
    });
    grantWith({ sub: 'внешний-2', email: 'u@example.com' });

    await callback(service);

    const link = inserted.find((i) => i.table === 'authAccounts');
    expect(link.values).toMatchObject({
      userId: 'user-2',
      authProviderId: 'prov-1',
      providerUserId: 'внешний-2',
    });
  });

  it('без allowSignup новый пользователь не заводится', async () => {
    const { service, inserted } = build();
    grantWith({ sub: 'внешний-3', email: 'новый@example.com' });

    await expect(callback(service)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(inserted).toHaveLength(0);
  });

  it('с allowSignup новый пользователь заводится и привязывается', async () => {
    const { service, inserted, userRepo } = build({
      provider: { ...PROVIDER, allowSignup: true },
    });
    grantWith({ sub: 'внешний-4', email: 'новый@example.com', name: 'Новый' });

    await callback(service);

    expect(userRepo.insertUser).toHaveBeenCalled();
    expect(inserted.some((i) => i.table === 'authAccounts')).toBe(true);
  });

  // Повышать права по данным внешнего провайдера нельзя.
  it('заведенный пользователь получает роль участника', async () => {
    const { service, userRepo } = build({
      provider: { ...PROVIDER, allowSignup: true },
    });
    grantWith({ sub: 'внешний-5', email: 'новый@example.com' });

    await callback(service);

    expect(userRepo.insertUser.mock.calls[0][0].role).toBe('member');
  });

  it('имя берется из почты, если провайдер его не дал', async () => {
    const { service, userRepo } = build({
      provider: { ...PROVIDER, allowSignup: true },
    });
    grantWith({ sub: 'внешний-6', email: 'ivanov@example.com' });

    await callback(service);

    expect(userRepo.insertUser.mock.calls[0][0].name).toBe('ivanov');
  });

  it('почта приводится к нижнему регистру', async () => {
    const { service, userRepo } = build({
      provider: { ...PROVIDER, allowSignup: true },
    });
    grantWith({ sub: 'внешний-7', email: 'Ivanov@Example.COM' });

    await callback(service);

    expect(userRepo.insertUser.mock.calls[0][0].email).toBe(
      'ivanov@example.com',
    );
  });
});

/**
 * Библиотека отказывается ходить по HTTP. Послабление привязано к тому,
 * развернуто ли само приложение по HTTPS: в установке на плain HTTP запрет
 * ничего не защищает, а вход ломает.
 */
describe('OidcService, издатель по HTTP', () => {
  const httpProvider = { ...PROVIDER, oidcIssuer: 'http://idp.local/realm' };

  it('при развертывании без HTTPS обращение разрешается', async () => {
    const { service } = build({ provider: httpProvider, isHttps: false });

    await service.buildLoginRedirect('prov-1', WORKSPACE);

    const options = client.discovery.mock.calls[0][4];
    expect(options.execute).toEqual(['послабление']);
  });

  // Если приложение работает по HTTPS, издатель обязан тоже.
  it('при развертывании по HTTPS издатель по HTTP отвергается', async () => {
    const { service } = build({ provider: httpProvider, isHttps: true });

    await expect(
      service.buildLoginRedirect('prov-1', WORKSPACE),
    ).rejects.toMatchObject({
      response: { code: 'error.sso.issuer_not_https' },
    });
  });

  it('издатель по HTTPS идет без послабления', async () => {
    const { service } = build({ isHttps: false });

    await service.buildLoginRedirect('prov-1', WORKSPACE);

    expect(client.discovery.mock.calls[0][4]).toBeUndefined();
  });

  it('неразбираемый адрес издателя дает понятную ошибку', async () => {
    const { service } = build({
      provider: { ...PROVIDER, oidcIssuer: 'не адрес' },
    });

    await expect(
      service.buildLoginRedirect('prov-1', WORKSPACE),
    ).rejects.toMatchObject({ response: { code: 'error.sso.issuer_invalid' } });
  });
});

/**
 * Роль пользователя, заведенного провайдером.
 *
 * Проверяется именно аргумент `addUserToWorkspace`: этот вызов идет после
 * `insertUser` и ставит роль последним, поэтому проверка одного `insertUser`
 * расхождения не ловит.
 */
describe('OidcService, роль заведенного пользователя', () => {
  it('роль ставится member явным аргументом, а не ролью пространства', async () => {
    const { service, workspaceService } = build({
      provider: { ...PROVIDER, allowSignup: true },
      existingUser: null,
    });

    grantWith({ sub: 'внешний-9', email: 'новый@example.com' });

    await service.handleCallback(
      'prov-1',
      'https://wiki.local/cb?code=x',
      FLOW,
      WORKSPACE,
    );

    expect(workspaceService.addUserToWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      WORKSPACE.id,
      'member',
      expect.anything(),
    );
  });
});

/**
 * Вход через провайдера обязан попадать в журнал наравне с парольным.
 *
 * Проверяется здесь, а не на уровне журнала: событие теряется именно на этом
 * пути, потому что до `authService.login` управление не доходит.
 */
describe('OidcService, отметка входа', () => {
  const callback = (service: OidcService) =>
    service.handleCallback(
      'prov-1',
      'https://wiki.local/cb?code=x',
      FLOW,
      WORKSPACE,
    );

  it('время последнего входа обновляется', async () => {
    const { service, userRepo } = build({ linked: { userId: 'user-1' } });
    grantWith({ sub: 'внешний-1', email: 'u@example.com' });

    await callback(service);

    expect(userRepo.updateLastLogin).toHaveBeenCalledWith(
      'user-1',
      WORKSPACE.id,
    );
  });

  it('пишется событие входа с указанием провайдера', async () => {
    const { service, auditService } = build({ linked: { userId: 'user-1' } });
    grantWith({ sub: 'внешний-1', email: 'u@example.com' });

    await callback(service);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.login',
        resourceType: 'user',
        resourceId: 'user-1',
        metadata: { source: 'oidc', providerId: 'prov-1' },
      }),
    );
  });

  // Маршрут публичный, перехватчик автора не проставит.
  it('автор события ставится явно', async () => {
    const { service, auditService } = build({ linked: { userId: 'user-1' } });
    grantWith({ sub: 'внешний-1', email: 'u@example.com' });

    await callback(service);

    expect(auditService.setActorId).toHaveBeenCalledWith('user-1');
  });

  it('при отказе провайдера событие входа не пишется', async () => {
    const { service, auditService, userRepo } = build();
    client.authorizationCodeGrant.mockRejectedValue(new Error('нет'));

    await expect(callback(service)).rejects.toThrow();

    expect(auditService.log).not.toHaveBeenCalled();
    expect(userRepo.updateLastLogin).not.toHaveBeenCalled();
  });
});

/**
 * Отметка входа ставится только после того, как сессия действительно выдана.
 *
 * `createSessionAndToken` отказывает отключенному в пространстве пользователю,
 * и отметка до этого вызова означала бы в журнале вход, которого не было.
 */
describe('OidcService, отказ в выдаче сессии', () => {
  it('отключенный пользователь не получает отметку входа', async () => {
    const { service, userRepo, auditService, sessionService } = build({
      linked: { userId: 'user-1' },
    });
    grantWith({ sub: 'внешний-1', email: 'u@example.com' });
    sessionService.createSessionAndToken.mockRejectedValue(
      new ForbiddenException(),
    );

    await expect(
      service.handleCallback(
        'prov-1',
        'https://wiki.local/cb?code=x',
        FLOW,
        WORKSPACE,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(userRepo.updateLastLogin).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });
});

/**
 * Привязка учетной записи идемпотентна по паре пользователь и провайдер.
 *
 * На этой паре стоит уникальное ограничение, а идентификатор у провайдера
 * может смениться. Обычная вставка в этом случае роняла бы вход.
 */
describe('OidcService, повторная привязка', () => {
  it('вставка связи идет с обновлением по конфликту', async () => {
    const { service, inserted } = build({
      existingUser: { id: 'user-7', email: 'u@example.com' },
    });
    grantWith({ sub: 'новый-идентификатор', email: 'u@example.com' });

    await service.handleCallback(
      'prov-1',
      'https://wiki.local/cb?code=x',
      FLOW,
      WORKSPACE,
    );

    const link = inserted.find((i: any) => i.table === 'authAccounts');
    expect(link.conflict).toEqual({
      columns: ['userId', 'authProviderId'],
      set: expect.objectContaining({
        providerUserId: 'новый-идентификатор',
        deletedAt: null,
      }),
    });
  });
});
