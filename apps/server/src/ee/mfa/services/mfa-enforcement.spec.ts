import { UnauthorizedException } from '@nestjs/common';
import { MfaService } from './mfa.service';

const WORKSPACE = (enforceMfa: boolean) =>
  ({ id: 'ws-1', name: 'Tessera', enforceMfa }) as any;

const USER = {
  id: 'user-1',
  email: 'user@example.com',
  workspaceId: 'ws-1',
  password: 'хеш',
} as any;

jest.mock('../../../common/helpers', () => ({
  comparePasswordHash: jest.fn(
    async (plain: string) => plain === 'верный-пароль',
  ),
}));

function build(options: { record?: any; user?: any } = {}) {
  const cookies: Record<string, string> = {};

  const chain: any = {
    selectAll: () => chain,
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () =>
      'record' in options ? options.record : undefined,
  };
  const db: any = { selectFrom: () => chain };

  const userRepo: any = {
    findByEmail: jest
      .fn()
      .mockResolvedValue('user' in options ? options.user : USER),
    findById: jest.fn().mockResolvedValue(USER),
  };
  const environmentService: any = {
    getAppSecret: () => 'секрет',
    isHttps: () => false,
  };
  const tokenService: any = {
    generateMfaToken: jest.fn().mockResolvedValue('промежуточный-токен'),
    verifyJwt: jest.fn(),
  };
  const sessionService: any = {
    createSessionAndToken: jest.fn().mockResolvedValue('сессия'),
  };

  const res: any = {
    setCookie: jest.fn((name: string, value: string) => {
      cookies[name] = value;
    }),
    clearCookie: jest.fn(),
  };

  const service = new MfaService(
    db,
    userRepo,
    environmentService,
    tokenService,
    sessionService,
    { sendToQueue: jest.fn() } as any,
    { createForUser: jest.fn() } as any,
    { log: jest.fn() } as any,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
  return { service, res, cookies, tokenService, userRepo, sessionService };
}

const login = { email: 'user@example.com', password: 'верный-пароль' };

describe('MfaService, принуждение рабочего пространства', () => {
  // Фактор не участвует, обычный путь входа не трогается.
  it('без фактора и без принуждения возвращается null', async () => {
    const { service, res } = build();

    await expect(
      service.checkMfaRequirements(login, WORKSPACE(false), res),
    ).resolves.toBeNull();
  });

  it('принуждение без фактора требует настройки', async () => {
    const { service, res, cookies } = build();

    const result = await service.checkMfaRequirements(
      login,
      WORKSPACE(true),
      res,
    );

    expect(result).toEqual({
      userHasMfa: false,
      requiresMfaSetup: true,
      isMfaEnforced: true,
    });
    // Сессия не выдается, вместо нее промежуточный токен.
    expect(cookies.mfaToken).toBe('промежуточный-токен');
    expect(cookies.authToken).toBeUndefined();
  });

  it('с подключенным фактором принуждение не требует настройки', async () => {
    const { service, res } = build({ record: { isEnabled: true } });

    const result = await service.checkMfaRequirements(
      login,
      WORKSPACE(true),
      res,
    );

    expect(result).toEqual({
      userHasMfa: true,
      requiresMfaSetup: false,
      isMfaEnforced: true,
    });
  });

  // По ответу нельзя узнать, у кого включен фактор, не зная пароля.
  it('неверный пароль отвергается до выдачи токена', async () => {
    const { service, res, cookies } = build();

    await expect(
      service.checkMfaRequirements(
        { ...login, password: 'неверный' },
        WORKSPACE(true),
        res,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(cookies.mfaToken).toBeUndefined();
  });

  it('несуществующий пользователь не раскрывается', async () => {
    const { service, res } = build({ user: undefined });

    await expect(
      service.checkMfaRequirements(login, WORKSPACE(true), res),
    ).resolves.toBeNull();
  });
});

describe('MfaService, состояние сеанса при принуждении', () => {
  const withToken = (build: any, payload: any) => {
    build.tokenService.verifyJwt.mockResolvedValue(payload);
  };

  it('принуждение без фактора дает признак настройки', async () => {
    const b = build();
    withToken(b, { sub: 'user-1', workspaceId: 'ws-1' });

    const result = await b.service.validateAccess('токен', WORKSPACE(true));

    expect(result).toMatchObject({
      valid: true,
      isTransferToken: true,
      userHasMfa: false,
      requiresMfaSetup: true,
    });
  });

  it('без токена сеанс недействителен', async () => {
    const b = build();

    await expect(
      b.service.validateAccess(undefined, WORKSPACE(true)),
    ).resolves.toEqual({ valid: false });
  });
});

describe('MfaService, кто действует при настройке', () => {
  it('сессия дает пользователя без признака промежуточного токена', async () => {
    const b = build();
    b.tokenService.verifyJwt.mockResolvedValue({
      sub: 'user-1',
      workspaceId: 'ws-1',
    });

    const actor = await b.service.resolveActor({ authToken: 'сессия' });

    expect(actor.fromMfaToken).toBe(false);
  });

  // При принудительной настройке обычной сессии еще нет.
  it('промежуточный токен дает пользователя с признаком', async () => {
    const b = build();
    b.tokenService.verifyJwt
      .mockRejectedValueOnce(new Error('не сессия'))
      .mockResolvedValueOnce({ sub: 'user-1', workspaceId: 'ws-1' });

    const actor = await b.service.resolveActor({
      authToken: 'просрочена',
      mfaToken: 'промежуточный',
    });

    expect(actor.fromMfaToken).toBe(true);
  });

  it('без обеих кук отказ', async () => {
    const b = build();

    await expect(b.service.resolveActor({})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('недействительные куки дают отказ', async () => {
    const b = build();
    b.tokenService.verifyJwt.mockRejectedValue(new Error('мусор'));

    await expect(
      b.service.resolveActor({ authToken: 'мусор', mfaToken: 'мусор' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
