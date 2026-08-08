import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { GoogleService } from './google.service';

const client = {
  discovery: jest.fn(),
  buildAuthorizationUrl: jest.fn(),
  randomPKCECodeVerifier: jest.fn(() => 'проверочное'),
  calculatePKCECodeChallenge: jest.fn(async () => 'вызов'),
  randomState: jest.fn(() => 'состояние'),
  authorizationCodeGrant: jest.fn(),
};

jest.mock('openid-client', () => ({
  discovery: jest.fn(),
  buildAuthorizationUrl: jest.fn(),
  randomPKCECodeVerifier: jest.fn(),
  calculatePKCECodeChallenge: jest.fn(),
  randomState: jest.fn(),
  authorizationCodeGrant: jest.fn(),
}));

import * as openidClient from 'openid-client';

const WORKSPACE = { id: 'ws-1' } as any;
const PROVIDER = { id: 'prov-google', type: 'google', allowSignup: true };
const USER = { id: 'user-1', workspaceId: 'ws-1' } as any;

const FLOW = {
  workspaceId: 'ws-1',
  state: 'состояние',
  codeVerifier: 'проверочное',
};

function build(options: { configured?: boolean; workspace?: any } = {}) {
  const m = openidClient as any;
  m.discovery.mockReset().mockResolvedValue({ настройка: true });
  m.buildAuthorizationUrl
    .mockReset()
    .mockReturnValue(new URL('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
  m.randomPKCECodeVerifier.mockReset().mockReturnValue('проверочное');
  m.calculatePKCECodeChallenge.mockReset().mockResolvedValue('вызов');
  m.randomState.mockReset().mockReturnValue('состояние');
  m.authorizationCodeGrant.mockReset();

  const ssoIdentity: any = {
    findEnabledProviderByType: jest.fn(async () => PROVIDER),
    resolveUser: jest.fn(async () => USER),
  };
  const workspaceRepo: any = {
    findById: jest.fn(async () =>
      'workspace' in options ? options.workspace : WORKSPACE,
    ),
  };
  const userRepo: any = { updateLastLogin: jest.fn(async () => undefined) };
  const sessionService: any = {
    createSessionAndToken: jest.fn(async () => 'сессия'),
  };
  const auditService: any = { log: jest.fn(), setActorId: jest.fn() };
  const configured = options.configured ?? true;
  const environmentService: any = {
    getAppUrl: () => 'https://wiki.local',
    isHttps: () => true,
    getGoogleClientId: () => (configured ? 'client-id' : ''),
    getGoogleClientSecret: () => (configured ? 'client-secret' : ''),
  };

  const service = new GoogleService(
    userRepo,
    workspaceRepo,
    sessionService,
    environmentService,
    ssoIdentity,
    auditService,
  );
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

  return { service, ssoIdentity, workspaceRepo, userRepo, auditService, m };
}

const grantWith = (claims: any) =>
  (openidClient as any).authorizationCodeGrant.mockResolvedValue({
    claims: () => claims,
    access_token: 'токен',
  });

describe('GoogleService, начало входа', () => {
  it('обратный адрес один на установку, без идентификатора провайдера', () => {
    const { service } = build();

    expect(service.callbackUrl()).toBe(
      'https://wiki.local/api/sso/google/callback',
    );
  });

  it('провайдер ищется по типу, а не по идентификатору', async () => {
    const { service, ssoIdentity } = build();

    await service.buildLoginRedirect('ws-1');

    expect(ssoIdentity.findEnabledProviderByType).toHaveBeenCalledWith(
      'ws-1',
      'google',
    );
  });

  it('пространство попадает в состояние потока', async () => {
    const { service } = build();

    const { flow } = await service.buildLoginRedirect('ws-1', '/home');

    expect(flow).toEqual({
      workspaceId: 'ws-1',
      state: 'состояние',
      codeVerifier: 'проверочное',
      redirect: '/home',
    });
  });

  it('PKCE применяется всегда', async () => {
    const { service, m } = build();

    await service.buildLoginRedirect('ws-1');

    expect(m.buildAuthorizationUrl.mock.calls[0][1]).toEqual(
      expect.objectContaining({ code_challenge_method: 'S256' }),
    );
  });

  it('без ключей вход не начинается', async () => {
    const { service } = build({ configured: false });

    await expect(service.buildLoginRedirect('ws-1')).rejects.toThrow(
      /не настроен/,
    );
  });

  it('неизвестное пространство отвергается', async () => {
    const { service } = build({ workspace: undefined });

    await expect(service.buildLoginRedirect('нет-такого')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('GoogleService, обратный вызов', () => {
  const callback = (service: GoogleService, flow: any = FLOW) =>
    service.handleCallback('https://wiki.local/cb?code=x', flow);

  it('без состояния потока вход отвергается', async () => {
    const { service } = build();

    await expect(callback(service, null)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('успешный вход выдает сессию и отмечает вход', async () => {
    const { service, userRepo, auditService } = build();
    grantWith({ sub: 'g-1', email: 'petrov@tessera.com', email_verified: true });

    await expect(callback(service)).resolves.toEqual({
      authToken: 'сессия',
      redirect: undefined,
    });

    expect(userRepo.updateLastLogin).toHaveBeenCalledWith('user-1', 'ws-1');
    expect(auditService.setActorId).toHaveBeenCalledWith('user-1');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { source: 'google', providerId: 'prov-google' },
      }),
    );
  });

  // По адресу мы связываем учетные записи, заведенные обычным способом.
  it('неподтвержденная почта отвергается', async () => {
    const { service, ssoIdentity } = build();
    grantWith({
      sub: 'g-1',
      email: 'petrov@tessera.com',
      email_verified: false,
    });

    await expect(callback(service)).rejects.toThrow(/не подтвержден/);
    expect(ssoIdentity.resolveUser).not.toHaveBeenCalled();
  });

  it('без почты вход отвергается', async () => {
    const { service } = build();
    grantWith({ sub: 'g-1', email_verified: true });

    await expect(callback(service)).rejects.toThrow(
      /адрес электронной почты/,
    );
  });

  it('без идентификатора вход отвергается', async () => {
    const { service } = build();
    grantWith({ email: 'petrov@tessera.com', email_verified: true });

    await expect(callback(service)).rejects.toThrow(/идентификатор/);
  });

  it('состояние сверяется с тем, что вернул провайдер', async () => {
    const { service, m } = build();
    grantWith({ sub: 'g-1', email: 'p@tessera.com', email_verified: true });

    await callback(service);

    expect(m.authorizationCodeGrant.mock.calls[0][2]).toEqual({
      pkceCodeVerifier: 'проверочное',
      expectedState: 'состояние',
    });
  });
});
