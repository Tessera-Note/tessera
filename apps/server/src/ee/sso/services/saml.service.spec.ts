import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { SAML } from '@node-saml/passport-saml';
import {
  SamlService,
  SAML_RELAY_MAX_BYTES,
  SAML_RELAY_TTL_SECONDS,
} from './saml.service';

const mockSamlInstance = {
  getAuthorizeUrlAsync: jest.fn(
    async (_relayState: string, _host: string, _options: unknown) =>
      'https://idp.example.com/sso?SAMLRequest=x',
  ),
  validatePostResponseAsync: jest.fn(),
};

jest.mock('@node-saml/passport-saml', () => ({
  SAML: jest.fn(() => mockSamlInstance),
  ValidateInResponseTo: {
    never: 'never',
    ifPresent: 'ifPresent',
    always: 'always',
  },
}));

const WORKSPACE = { id: 'ws-1' } as any;

const PROVIDER = {
  id: 'prov-1',
  type: 'saml',
  samlUrl: 'https://idp.example.com/sso',
  samlCertificate: 'СЕРТИФИКАТ',
  allowSignup: false,
};

const USER = { id: 'user-1', workspaceId: 'ws-1' } as any;

function build(options: { provider?: any } = {}) {
  const ssoIdentity: any = {
    findEnabledProvider: jest.fn(async () =>
      'provider' in options ? options.provider : PROVIDER,
    ),
    resolveUser: jest.fn(async () => USER),
  };
  const userRepo: any = { updateLastLogin: jest.fn(async () => undefined) };
  const sessionService: any = {
    createSessionAndToken: jest.fn(async () => 'сессия'),
  };
  const auditService: any = { log: jest.fn(), setActorId: jest.fn() };
  const cacheProvider: any = {
    saveAsync: jest.fn(),
    getAsync: jest.fn(),
    removeAsync: jest.fn(),
  };
  const environmentService: any = {
    getAppUrl: () => 'https://wiki.local',
    getAppSecret: () => 'секрет-приложения',
    getSamlDisableRequestedAuthnContext: () => false,
  };

  const requestCache: any = {
    forProvider: jest.fn(() => cacheProvider),
  };

  const service = new SamlService(
    userRepo,
    sessionService,
    environmentService,
    ssoIdentity,
    requestCache,
    auditService,
  );
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

  return {
    service,
    ssoIdentity,
    userRepo,
    sessionService,
    auditService,
    requestCache,
    cacheProvider,
  };
}

/** Значение RelayState, выданное сервисом для указанного провайдера. */
async function relayFor(
  service: SamlService,
  providerId = 'prov-1',
  redirect?: string,
): Promise<string> {
  mockSamlInstance.getAuthorizeUrlAsync.mockClear();
  await service.buildLoginRedirect(providerId, WORKSPACE, redirect);
  return mockSamlInstance.getAuthorizeUrlAsync.mock.calls[0][0] as string;
}

const profileOf = (extra: any = {}) => ({
  nameID: 'petrov@tessera.com',
  ...extra,
});

const acceptResponse = (profile: any) =>
  mockSamlInstance.validatePostResponseAsync.mockResolvedValue({
    profile,
    loggedOut: false,
  } as never);

afterEach(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.clearAllMocks();
  mockSamlInstance.getAuthorizeUrlAsync.mockResolvedValue(
    'https://idp.example.com/sso?SAMLRequest=x' as never,
  );
});

describe('SamlService, начало входа', () => {
  it('провайдер ищется по типу saml', async () => {
    const { service, ssoIdentity } = build();

    await service.buildLoginRedirect('prov-1', WORKSPACE);

    expect(ssoIdentity.findEnabledProvider).toHaveBeenCalledWith(
      'prov-1',
      'ws-1',
      'saml',
    );
  });

  it('возвращается адрес провайдера', async () => {
    const { service } = build();

    await expect(
      service.buildLoginRedirect('prov-1', WORKSPACE),
    ).resolves.toEqual({ url: 'https://idp.example.com/sso?SAMLRequest=x' });
  });

  // Подпись ответа и утверждения не должна зависеть от умолчаний библиотеки.
  it('проверка подписи ответа и утверждения включена явно', async () => {
    const { service } = build();

    await service.buildLoginRedirect('prov-1', WORKSPACE);

    const options = (SAML as unknown as jest.Mock).mock.calls[0][0];
    expect(options).toEqual(
      expect.objectContaining({
        identifierFormat: null,
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: true,
        validateInResponseTo: 'always',
        entryPoint: PROVIDER.samlUrl,
        idpCert: PROVIDER.samlCertificate,
        issuer: 'https://wiki.local/api/sso/saml/prov-1/login',
        audience: 'https://wiki.local/api/sso/saml/prov-1/login',
        callbackUrl: 'https://wiki.local/api/sso/saml/prov-1/callback',
      }),
    );
  });
});

describe('SamlService, состояние потока', () => {
  it('состояние помещается в предел спецификации', async () => {
    const { service } = build();

    const relay = await relayFor(service, 'prov-1', '/home');

    expect(Buffer.byteLength(relay)).toBeLessThanOrEqual(SAML_RELAY_MAX_BYTES);
  });

  // Реальный путь страницы, а не короткая заглушка: прежняя упаковка через
  // JSON и base64 на такой длине уже не помещалась в предел, и точка возврата
  // отбрасывалась при каждом входе.
  it('реальный путь страницы переживает поток', async () => {
    const { service } = build();
    const path = '/s/general/p/welcome-abc123';
    const relay = await relayFor(service, 'prov-1', path);
    acceptResponse(profileOf());

    expect(Buffer.byteLength(relay)).toBeLessThanOrEqual(SAML_RELAY_MAX_BYTES);

    const result = await service.handleCallback('prov-1', WORKSPACE, {
      SAMLResponse: 'ответ',
      RelayState: relay,
    });

    expect(result.redirect).toBe(path);
  });

  it('путь с точками разбирается верно', async () => {
    const { service } = build();
    const path = '/s/docs/p/v1.2.3';
    const relay = await relayFor(service, 'prov-1', path);
    acceptResponse(profileOf());

    const result = await service.handleCallback('prov-1', WORKSPACE, {
      SAMLResponse: 'ответ',
      RelayState: relay,
    });

    expect(result.redirect).toBe(path);
  });

  // Слишком длинное значение часть провайдеров отвергает целиком.
  it('слишком длинная точка возврата отбрасывается, а не отправляется', async () => {
    const { service } = build();
    const long = `/s/general/p/${'я'.repeat(60)}`;

    const relay = await relayFor(service, 'prov-1', long);

    expect(Buffer.byteLength(relay)).toBeLessThanOrEqual(SAML_RELAY_MAX_BYTES);
    acceptResponse(profileOf());
    const result = await service.handleCallback('prov-1', WORKSPACE, {
      SAMLResponse: 'ответ',
      RelayState: relay,
    });
    expect(result.redirect).toBeUndefined();
  });

  it('подделанное состояние отвергается', async () => {
    const { service } = build();
    const relay = await relayFor(service, 'prov-1', '/home');
    const [body] = relay.split('.');
    acceptResponse(profileOf());

    await expect(
      service.handleCallback('prov-1', WORKSPACE, {
        SAMLResponse: 'ответ',
        RelayState: `${body}.ZmFrZQ`,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  // Идентификатор провайдера входит в подпись, но не в тело.
  it('состояние одного провайдера не принимает обратный вызов другого', async () => {
    const { service } = build();
    const relay = await relayFor(service, 'prov-1', '/home');
    acceptResponse(profileOf());

    await expect(
      service.handleCallback('prov-2', WORKSPACE, {
        SAMLResponse: 'ответ',
        RelayState: relay,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('просроченное состояние отвергается', async () => {
    const { service } = build();
    const relay = await relayFor(service, 'prov-1', '/home');
    acceptResponse(profileOf());

    const later = Date.now() + (SAML_RELAY_TTL_SECONDS + 60) * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(later);

    await expect(
      service.handleCallback('prov-1', WORKSPACE, {
        SAMLResponse: 'ответ',
        RelayState: relay,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('отсутствие состояния отвергается', async () => {
    const { service } = build();
    acceptResponse(profileOf());

    await expect(
      service.handleCallback('prov-1', WORKSPACE, { SAMLResponse: 'ответ' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('SamlService, обратный вызов', () => {
  it('пустой ответ отвергается до обращения к провайдеру', async () => {
    const { service, ssoIdentity } = build();

    await expect(
      service.handleCallback('prov-1', WORKSPACE, {}),
    ).rejects.toThrow(UnauthorizedException);

    expect(ssoIdentity.findEnabledProvider).not.toHaveBeenCalled();
  });

  it('отвергнутая подпись дает отказ входа', async () => {
    const { service } = build();
    const relay = await relayFor(service);
    mockSamlInstance.validatePostResponseAsync.mockRejectedValue(
      new Error('подпись неверна') as never,
    );

    await expect(
      service.handleCallback('prov-1', WORKSPACE, {
        SAMLResponse: 'ответ',
        RelayState: relay,
      }),
    ).rejects.toMatchObject({ response: { code: 'error.sso.not_confirmed' } });
  });

  it('профиль без почты дает понятный отказ', async () => {
    const { service } = build();
    const relay = await relayFor(service);
    acceptResponse({ nameID: 'не-почта' });

    await expect(
      service.handleCallback('prov-1', WORKSPACE, {
        SAMLResponse: 'ответ',
        RelayState: relay,
      }),
    ).rejects.toMatchObject({ response: { code: 'error.sso.no_email' } });
  });

  it('успешный вход выдает сессию и отмечает вход', async () => {
    const { service, userRepo, auditService, ssoIdentity } = build();
    const relay = await relayFor(service);
    acceptResponse(profileOf());

    const result = await service.handleCallback('prov-1', WORKSPACE, {
      SAMLResponse: 'ответ',
      RelayState: relay,
    });

    expect(result.authToken).toBe('сессия');
    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'petrov@tessera.com',
        email: 'petrov@tessera.com',
      }),
    );
    expect(userRepo.updateLastLogin).toHaveBeenCalledWith('user-1', 'ws-1');
    expect(auditService.setActorId).toHaveBeenCalledWith('user-1');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { source: 'saml', providerId: 'prov-1' },
      }),
    );
  });

  it('отключенный пользователь не получает отметку входа', async () => {
    const { service, userRepo, auditService, sessionService } = build();
    const relay = await relayFor(service);
    acceptResponse(profileOf());
    sessionService.createSessionAndToken.mockRejectedValue(
      new ForbiddenException(),
    );

    await expect(
      service.handleCallback('prov-1', WORKSPACE, {
        SAMLResponse: 'ответ',
        RelayState: relay,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(userRepo.updateLastLogin).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });
});

/**
 * Провайдеры называют утверждения по-разному, поэтому разбор перебирает
 * короткие имена, схему claims и номера OID.
 */
describe('SamlService, разбор профиля', () => {
  const callbackWith = async (profile: any) => {
    const { service, ssoIdentity } = build();
    const relay = await relayFor(service);
    acceptResponse(profile);
    await service.handleCallback('prov-1', WORKSPACE, {
      SAMLResponse: 'ответ',
      RelayState: relay,
    });
    return ssoIdentity.resolveUser.mock.calls[0][0];
  };

  it('почта берется из короткого имени утверждения', async () => {
    const call = await callbackWith({
      nameID: 'внешний-1',
      attributes: { mail: 'a@tessera.com' },
    });

    expect(call.email).toBe('a@tessera.com');
  });

  it('почта берется из схемы claims', async () => {
    const call = await callbackWith({
      nameID: 'внешний-1',
      attributes: {
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress':
          'b@tessera.com',
      },
    });

    expect(call.email).toBe('b@tessera.com');
  });

  it('почта берется из номера OID', async () => {
    const call = await callbackWith({
      nameID: 'внешний-1',
      attributes: { 'urn:oid:0.9.2342.19200300.100.1.3': 'c@tessera.com' },
    });

    expect(call.email).toBe('c@tessera.com');
  });

  it('значения-списки разбираются по первому элементу', async () => {
    const call = await callbackWith({
      nameID: 'внешний-1',
      attributes: { email: ['d@tessera.com', 'запасная@tessera.com'] },
    });

    expect(call.email).toBe('d@tessera.com');
  });

  it('почта приводится к нижнему регистру', async () => {
    const call = await callbackWith({
      nameID: 'внешний-1',
      attributes: { email: 'Пётр.Петров@Tessera.com' },
    });

    expect(call.email).toBe('пётр.петров@tessera.com');
  });

  it('имя собирается из имени и фамилии, когда целого нет', async () => {
    const call = await callbackWith({
      nameID: 'внешний-1',
      attributes: { email: 'e@tessera.com', givenName: 'Пётр', sn: 'Петров' },
    });

    expect(call.name).toBe('Пётр Петров');
  });

  it('целое имя имеет приоритет над составным', async () => {
    const call = await callbackWith({
      nameID: 'внешний-1',
      displayName: 'Пётр Петров',
      attributes: { email: 'f@tessera.com', givenName: 'Иван', sn: 'Иванов' },
    });

    expect(call.name).toBe('Пётр Петров');
  });

  it('без имени в профиле имя не передается', async () => {
    const call = await callbackWith({
      nameID: 'внешний-1',
      attributes: { email: 'g@tessera.com' },
    });

    expect(call.name).toBeUndefined();
  });

  it('идентификатором остается NameID, а не почта из утверждения', async () => {
    const call = await callbackWith({
      nameID: 'постоянный-идентификатор',
      attributes: { email: 'h@tessera.com' },
    });

    expect(call.subject).toBe('постоянный-идентификатор');
  });
});

/**
 * Сверка InResponseTo.
 *
 * Без хранилища библиотека молча подставляет свое, процесс-локальное, и на
 * нескольких экземплярах приложения вход ломается тихо. Поэтому проверяется
 * не только режим, но и то, что хранилище действительно передано.
 */
describe('SamlService, сверка InResponseTo', () => {
  it('хранилище передается библиотеке, а не остается умолчанием', async () => {
    const { service, cacheProvider } = build();

    await service.buildLoginRedirect('prov-1', WORKSPACE);

    const options = (SAML as unknown as jest.Mock).mock.calls[0][0];
    expect(options.cacheProvider).toBe(cacheProvider);
  });

  it('хранилище привязано к провайдеру', async () => {
    const { service, requestCache } = build();

    await service.buildLoginRedirect('prov-1', WORKSPACE);

    expect(requestCache.forProvider).toHaveBeenCalledWith(
      'prov-1',
      SAML_RELAY_TTL_SECONDS * 1000,
    );
  });

  // Разные сроки означали бы, что одна проверка молча переживает другую.
  it('срок жизни идентификатора совпадает со сроком состояния потока', async () => {
    const { service } = build();

    await service.buildLoginRedirect('prov-1', WORKSPACE);

    const options = (SAML as unknown as jest.Mock).mock.calls[0][0];
    expect(options.requestIdExpirationPeriodMs).toBe(
      SAML_RELAY_TTL_SECONDS * 1000,
    );
  });
});
