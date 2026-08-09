import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Client } from 'ldapts';
import { LdapService } from './ldap.service';

/**
 * Клиенты каталога, которые получит сервис, в порядке создания.
 *
 * Первый ищет запись служебной учетной записью, второй проверяет пароль
 * пользователя. Разделение принципиальное: на одном соединении последующие
 * операции пошли бы от имени пользователя.
 */
const mockClients: any[] = [];

const makeClient = () => ({
  startTLS: jest.fn(async () => undefined),
  bind: jest.fn(async () => undefined),
  search: jest.fn(async () => ({ searchEntries: [], searchReferences: [] })),
  unbind: jest.fn(async () => undefined),
});

jest.mock('ldapts', () => ({
  Client: jest.fn(),
}));

jest.mock('../../ai/ai-secret.util', () => ({
  decryptSecret: jest.fn(() => 'пароль-служебной'),
}));

const WORKSPACE = { id: 'ws-1' } as any;

const PROVIDER = {
  id: 'prov-1',
  type: 'ldap',
  ldapUrl: 'ldap://directory.local:389',
  ldapBindDn: 'cn=service,dc=tessera,dc=local',
  ldapBindPassword: 'зашифровано',
  ldapBaseDn: 'dc=tessera,dc=local',
  ldapUserSearchFilter: '(mail={{username}})',
  ldapUserAttributes: {},
  ldapTlsEnabled: false,
  allowSignup: true,
};

const ENTRY = {
  dn: 'cn=petrov,dc=tessera,dc=local',
  entryUUID: 'устойчивый-1',
  mail: 'petrov@tessera.com',
  displayName: 'Пётр Петров',
};

const USER = { id: 'user-1', workspaceId: 'ws-1' } as any;

function build(
  options: { provider?: any; entries?: any[]; userBindError?: unknown } = {},
) {
  mockClients.length = 0;

  const search = jest.fn(async () => ({
    searchEntries: 'entries' in options ? options.entries : [ENTRY],
    searchReferences: [],
  }));

  (Client as unknown as jest.Mock).mockReset();
  (Client as unknown as jest.Mock).mockImplementation(() => {
    const client = makeClient();
    if (mockClients.length === 0) {
      // Первый клиент ищет запись служебной учетной записью.
      client.search = search as any;
    } else if (options.userBindError) {
      // Второй проверяет пароль пользователя.
      client.bind = jest.fn(async () => {
        throw options.userBindError;
      }) as any;
    }
    mockClients.push(client);
    return client;
  });

  const ssoIdentity: any = {
    findEnabledProvider: jest.fn(async () => options.provider ?? PROVIDER),
    resolveUser: jest.fn(async () => USER),
  };
  const userRepo: any = { updateLastLogin: jest.fn(async () => undefined) };
  const sessionService: any = {
    createSessionAndToken: jest.fn(async () => 'сессия'),
  };
  const auditService: any = { log: jest.fn(), setActorId: jest.fn() };

  const service = new LdapService(
    userRepo,
    sessionService,
    { getAppSecret: () => 'секрет' } as any,
    ssoIdentity,
    auditService,
  );
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

  return { service, ssoIdentity, userRepo, sessionService, auditService };
}

const login = (service: LdapService, username = 'petrov') =>
  service.login('prov-1', WORKSPACE, { username, password: 'пароль' });

describe('LdapService, успешный вход', () => {
  it('провайдер ищется по типу ldap', async () => {
    const { service, ssoIdentity } = build();

    await login(service);

    expect(ssoIdentity.findEnabledProvider).toHaveBeenCalledWith(
      'prov-1',
      'ws-1',
      'ldap',
    );
  });

  // На одном соединении дальнейшие операции пошли бы от имени пользователя.
  it('поиск и проверка пароля идут разными подключениями', async () => {
    const { service } = build();

    await login(service);

    expect(mockClients).toHaveLength(2);
    expect(mockClients[0].search).toHaveBeenCalled();
    expect(mockClients[1].bind).toHaveBeenCalledWith(ENTRY.dn, 'пароль');
  });

  it('служебная привязка идет заданным DN', async () => {
    const { service } = build();

    await login(service);

    expect(mockClients[0].bind).toHaveBeenCalledWith(
      PROVIDER.ldapBindDn,
      'пароль-служебной',
    );
  });

  it('соединения закрываются в обоих случаях', async () => {
    const { service } = build();

    await login(service);

    expect(mockClients[0].unbind).toHaveBeenCalled();
    expect(mockClients[1].unbind).toHaveBeenCalled();
  });

  it('пользователь резолвится по устойчивому идентификатору и почте', async () => {
    const { service, ssoIdentity } = build();

    await login(service);

    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'устойчивый-1',
        email: 'petrov@tessera.com',
        name: 'Пётр Петров',
      }),
    );
  });

  it('вход отмечается после выдачи сессии', async () => {
    const { service, userRepo, auditService } = build();

    await expect(login(service)).resolves.toEqual({ authToken: 'сессия' });

    expect(userRepo.updateLastLogin).toHaveBeenCalledWith('user-1', 'ws-1');
    expect(auditService.setActorId).toHaveBeenCalledWith('user-1');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { source: 'ldap', providerId: 'prov-1' },
      }),
    );
  });
});

describe('LdapService, устойчивый идентификатор', () => {
  it('objectGUID берется, когда entryUUID нет', async () => {
    const { service, ssoIdentity } = build({
      entries: [
        {
          dn: ENTRY.dn,
          objectGUID: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
          mail: 'petrov@tessera.com',
        },
      ],
    });

    await login(service);

    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'deadbeef' }),
    );
  });

  it('entryUUID имеет приоритет над objectGUID', async () => {
    const { service, ssoIdentity } = build({
      entries: [
        {
          ...ENTRY,
          objectGUID: Buffer.from([0x01]),
        },
      ],
    });

    await login(service);

    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'устойчивый-1' }),
    );
  });

  /**
   * Отката на DN нет намеренно: DN меняется при переименовании и переносе,
   * связь тихо разорвалась бы, и человек получил бы отказ во входе.
   */
  it('без устойчивого идентификатора вход отвергается, а не идет по DN', async () => {
    const { service, ssoIdentity } = build({
      entries: [{ dn: ENTRY.dn, mail: 'petrov@tessera.com' }],
    });

    await expect(login(service)).rejects.toThrow(ServiceUnavailableException);
    expect(ssoIdentity.resolveUser).not.toHaveBeenCalled();
  });
});

describe('LdapService, отказы', () => {
  it('запись не найдена: общий отказ, без перечисления учетных записей', async () => {
    const { service } = build({ entries: [] });

    await expect(login(service)).rejects.toMatchObject({
      response: { code: 'error.sso.credentials_invalid' },
    });
  });

  it('неверный пароль пользователя дает тот же общий отказ', async () => {
    const { service } = build({
      userBindError: Object.assign(new Error('invalid credentials'), {
        code: 49,
      }),
    });

    await expect(login(service)).rejects.toThrow(UnauthorizedException);
  });

  // Сбой сети на проверке пароля не должен выглядеть как неверный пароль.
  it('недоступность каталога на проверке пароля отличается от отказа', async () => {
    const { service } = build({
      userBindError: Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    });

    await expect(login(service)).rejects.toThrow(ServiceUnavailableException);
  });

  // Протухший пароль служебной записи это ошибка настройки: сказать про
  // пароль пользователя значит отправить всех чинить не то.
  it('неверный пароль служебной записи дает отказ каталога', async () => {
    const { service } = build();
    (Client as unknown as jest.Mock).mockImplementationOnce(() => {
      const client = makeClient();
      client.bind = jest.fn(async () => {
        throw Object.assign(new Error('invalid credentials'), { code: 49 });
      });
      mockClients.push(client);
      return client;
    });

    await expect(login(service)).rejects.toThrow(ServiceUnavailableException);
  });

  it('несколько найденных записей это ошибка настройки', async () => {
    const { service } = build({ entries: [ENTRY, { ...ENTRY, dn: 'другой' }] });

    await expect(login(service)).rejects.toThrow(ServiceUnavailableException);
  });

  it('запись без почты дает понятный отказ', async () => {
    const { service } = build({
      entries: [{ dn: ENTRY.dn, entryUUID: 'устойчивый-1' }],
    });

    await expect(login(service)).rejects.toMatchObject({
      response: { code: 'error.sso.directory_no_email' },
    });
  });
});

describe('LdapService, фильтр и шифрование', () => {
  it('имя экранируется перед подстановкой в фильтр', async () => {
    const { service } = build();

    await login(service, '*)(objectClass=*');

    const options = mockClients[0].search.mock.calls[0][1];
    expect(options.filter).toBe('(mail=\\2a\\29\\28objectClass=\\2a)');
  });

  it('операционные атрибуты запрашиваются явно', async () => {
    const { service } = build();

    await login(service);

    const options = mockClients[0].search.mock.calls[0][1];
    expect(options.attributes).toEqual(expect.arrayContaining(['entryUUID']));
    expect(options.explicitBufferAttributes).toEqual(['objectGUID']);
  });

  it('на ldaps StartTLS не вызывается', async () => {
    const { service } = build({
      provider: { ...PROVIDER, ldapUrl: 'ldaps://directory.local:636' },
    });

    await login(service);

    expect(mockClients[0].startTLS).not.toHaveBeenCalled();
  });

  it('на открытом ldap с включенным флагом вызывается StartTLS', async () => {
    const { service } = build({
      provider: { ...PROVIDER, ldapTlsEnabled: true },
    });

    await login(service);

    expect(mockClients[0].startTLS).toHaveBeenCalled();
    expect(mockClients[1].startTLS).toHaveBeenCalled();
  });
});

describe('LdapService, сопоставление атрибутов', () => {
  it('сопоставление из настройки имеет приоритет над умолчаниями', async () => {
    const { service, ssoIdentity } = build({
      provider: {
        ...PROVIDER,
        ldapUserAttributes: { email: 'userPrincipalName', name: 'cn' },
      },
      entries: [
        {
          dn: ENTRY.dn,
          entryUUID: 'устойчивый-1',
          mail: 'не-этот@tessera.com',
          userPrincipalName: 'этот@tessera.com',
          displayName: 'Не это имя',
          cn: 'Это имя',
        },
      ],
    });

    await login(service);

    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'этот@tessera.com',
        name: 'Это имя',
      }),
    );
  });

  it('имя собирается из частей, когда целого нет', async () => {
    const { service, ssoIdentity } = build({
      entries: [
        {
          dn: ENTRY.dn,
          entryUUID: 'устойчивый-1',
          mail: 'petrov@tessera.com',
          givenName: 'Пётр',
          sn: 'Петров',
        },
      ],
    });

    await login(service);

    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Пётр Петров' }),
    );
  });

  it('почта приводится к нижнему регистру', async () => {
    const { service, ssoIdentity } = build({
      entries: [{ dn: ENTRY.dn, entryUUID: 'у-1', mail: 'Petrov@Tessera.COM' }],
    });

    await login(service);

    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'petrov@tessera.com' }),
    );
  });
});

/**
 * Имена атрибутов в LDAP регистронезависимы по RFC 4512, и каталоги этим
 * пользуются по-разному. Побуквенное сравнение отвергало вход на каталоге,
 * который на самом деле все отдал.
 */
describe('LdapService, регистр имен атрибутов', () => {
  it('идентификатор находится, когда каталог отдал его строчными', async () => {
    const { service, ssoIdentity } = build({
      entries: [
        {
          dn: ENTRY.dn,
          entryuuid: 'строчными-1',
          mail: 'petrov@tessera.com',
        },
      ],
    });

    await login(service);

    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'строчными-1' }),
    );
  });

  it('почта и имя находятся при любом регистре', async () => {
    const { service, ssoIdentity } = build({
      entries: [
        {
          dn: ENTRY.dn,
          ENTRYUUID: 'заглавными-1',
          MAIL: 'petrov@tessera.com',
          DISPLAYNAME: 'Пётр Петров',
        },
      ],
    });

    await login(service);

    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'заглавными-1',
        email: 'petrov@tessera.com',
        name: 'Пётр Петров',
      }),
    );
  });

  it('сопоставление из настройки тоже нечувствительно к регистру', async () => {
    const { service, ssoIdentity } = build({
      provider: {
        ...PROVIDER,
        ldapUserAttributes: { email: 'userPrincipalName' },
      },
      entries: [
        {
          dn: ENTRY.dn,
          entryuuid: 'у-1',
          userprincipalname: 'этот@tessera.com',
        },
      ],
    });

    await login(service);

    expect(ssoIdentity.resolveUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'этот@tessera.com' }),
    );
  });
});
