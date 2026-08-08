import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { MfaService } from './mfa.service';

/**
 * Отметка входа на путях второго фактора.
 *
 * Когда `checkMfaRequirements` возвращает не-`null`, управление до
 * `authService.login` не доходит, и время последнего входа вместе с событием
 * журнала не пишет никто. Здесь проверяются оба места, где вход фактически
 * завершается: подтверждение кода и завершение принудительной настройки.
 */
const USER = {
  id: 'user-1',
  email: 'user@example.com',
  workspaceId: 'ws-1',
} as any;

function build() {
  const userRepo: any = {
    findById: jest.fn().mockResolvedValue(USER),
    updateLastLogin: jest.fn().mockResolvedValue(undefined),
  };
  const tokenService: any = {
    verifyJwt: jest
      .fn()
      .mockResolvedValue({ sub: 'user-1', workspaceId: 'ws-1' }),
  };
  const sessionService: any = {
    createSessionAndToken: jest.fn().mockResolvedValue('сессия'),
  };
  const auditService: any = { log: jest.fn(), setActorId: jest.fn() };

  const service = new MfaService(
    {} as any,
    userRepo,
    { getAppSecret: () => 'секрет', isHttps: () => false } as any,
    tokenService,
    sessionService,
    { sendToQueue: jest.fn() } as any,
    { createForUser: jest.fn() } as any,
    auditService,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});

  return { service, userRepo, sessionService, auditService };
}

const withCode = (service: MfaService, verified: boolean) =>
  jest.spyOn(service as any, 'verifyCode').mockResolvedValue(verified as never);

describe('MfaService, подтверждение кода', () => {
  it('время последнего входа обновляется', async () => {
    const { service, userRepo } = build();
    withCode(service, true);

    await service.completeLogin('токен', '123456');

    expect(userRepo.updateLastLogin).toHaveBeenCalledWith('user-1', 'ws-1');
  });

  it('пишется событие входа с источником mfa', async () => {
    const { service, auditService } = build();
    withCode(service, true);

    await service.completeLogin('токен', '123456');

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.login',
        resourceType: 'user',
        resourceId: 'user-1',
        metadata: { source: 'mfa' },
      }),
    );
  });

  // Маршрут публичный, перехватчик автора не проставит.
  it('автор события ставится явно', async () => {
    const { service, auditService } = build();
    withCode(service, true);

    await service.completeLogin('токен', '123456');

    expect(auditService.setActorId).toHaveBeenCalledWith('user-1');
  });

  it('возвращается токен выданной сессии', async () => {
    const { service, sessionService } = build();
    withCode(service, true);

    await expect(service.completeLogin('токен', '123456')).resolves.toBe(
      'сессия',
    );
    expect(sessionService.createSessionAndToken).toHaveBeenCalledWith(USER);
  });

  it('при неверном коде вход не отмечается', async () => {
    const { service, userRepo, auditService } = build();
    withCode(service, false);

    await expect(service.completeLogin('токен', '000000')).rejects.toThrow(
      UnauthorizedException,
    );

    expect(userRepo.updateLastLogin).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });
});

describe('MfaService, завершение принудительной настройки', () => {
  it('вход отмечается с отдельным источником', async () => {
    const { service, userRepo, auditService } = build();

    await expect(service.createSession(USER)).resolves.toBe('сессия');

    expect(userRepo.updateLastLogin).toHaveBeenCalledWith('user-1', 'ws-1');
    expect(auditService.setActorId).toHaveBeenCalledWith('user-1');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { source: 'mfa_setup' } }),
    );
  });
});

/**
 * Отметка входа ставится только после того, как сессия действительно выдана.
 *
 * `createSessionAndToken` отказывает отключенному в пространстве пользователю,
 * и отметка до этого вызова означала бы в журнале вход, которого не было.
 */
describe('MfaService, отказ в выдаче сессии', () => {
  it('отключенный пользователь не получает отметку входа', async () => {
    const { service, userRepo, auditService, sessionService } = build();
    withCode(service, true);
    sessionService.createSessionAndToken.mockRejectedValue(
      new ForbiddenException(),
    );

    await expect(service.completeLogin('токен', '123456')).rejects.toThrow(
      ForbiddenException,
    );

    expect(userRepo.updateLastLogin).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });
});
