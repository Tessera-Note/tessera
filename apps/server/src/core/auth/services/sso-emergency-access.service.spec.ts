import { BadRequestException } from '@nestjs/common';
import { SsoEmergencyAccessService } from './sso-emergency-access.service';

/**
 * Аварийный вход по паролю при включенном принуждении SSO.
 *
 * Смысл механизма в том, чтобы работать именно тогда, когда провайдер
 * сломан. Поэтому он не обращается ни к провайдеру, ни к чему-либо, что
 * может быть недоступно вместе с ним: только переменная окружения и роль
 * пользователя в базе.
 */
const WORKSPACE = { id: 'ws-1', enforceSso: true } as any;

function build(
  options: { enabled?: boolean; user?: any; workspace?: any } = {},
) {
  const environmentService: any = {
    isSsoEmergencyAccessEnabled: () => options.enabled ?? true,
  };
  const userRepo: any = {
    findByEmail: jest.fn(async () =>
      'user' in options ? options.user : { id: 'user-1', role: 'admin' },
    ),
  };
  const workspaceRepo: any = {
    findFirst: jest.fn(async () =>
      'workspace' in options ? options.workspace : WORKSPACE,
    ),
  };
  const auditService: any = {
    log: jest.fn(),
    logWithContext: jest.fn(),
    setActorId: jest.fn(),
  };

  const service = new SsoEmergencyAccessService(
    environmentService,
    userRepo,
    workspaceRepo,
    auditService,
  );
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

  return { service, userRepo, auditService };
}

describe('SsoEmergencyAccessService, допуск', () => {
  it('администратор пропускается', async () => {
    const { service } = build({ user: { id: 'u-1', role: 'admin' } });

    await expect(
      service.assertAllowed(WORKSPACE, 'admin@tessera.com'),
    ).resolves.toBeUndefined();
  });

  it('владелец пропускается', async () => {
    const { service } = build({ user: { id: 'u-1', role: 'owner' } });

    await expect(
      service.assertAllowed(WORKSPACE, 'owner@tessera.com'),
    ).resolves.toBeUndefined();
  });

  it('обычный участник не пропускается', async () => {
    const { service } = build({ user: { id: 'u-2', role: 'member' } });

    await expect(
      service.assertAllowed(WORKSPACE, 'member@tessera.com'),
    ).rejects.toThrow(BadRequestException);
  });

  it('при выключенной переменной не пропускается никто', async () => {
    const { service } = build({
      enabled: false,
      user: { id: 'u-1', role: 'owner' },
    });

    await expect(
      service.assertAllowed(WORKSPACE, 'owner@tessera.com'),
    ).rejects.toThrow(BadRequestException);
  });

  /**
   * Отказ одинаков во всех случаях и совпадает с обычным отказом при
   * принуждении. Иначе форма входа отличала бы администратора от прочих
   * и стала бы способом их перечислить.
   */
  it('отказ неотличим для участника и для несуществующего адреса', async () => {
    const member = build({ user: { id: 'u-2', role: 'member' } });
    const missing = build({ user: undefined });

    const first = await member.service
      .assertAllowed(WORKSPACE, 'member@tessera.com')
      .catch((e) => e.message);
    const second = await missing.service
      .assertAllowed(WORKSPACE, 'нет-такого@tessera.com')
      .catch((e) => e.message);

    expect(first).toBe('This workspace has enforced SSO login.');
    expect(second).toBe(first);
  });
});

describe('SsoEmergencyAccessService, журнал', () => {
  it('допуск пишется отдельным событием с автором', async () => {
    const { service, auditService } = build({
      user: { id: 'u-1', role: 'owner' },
    });

    await service.assertAllowed(WORKSPACE, 'owner@tessera.com');

    expect(auditService.setActorId).toHaveBeenCalledWith('u-1');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.emergency_login',
        resourceType: 'user',
        resourceId: 'u-1',
        metadata: { role: 'owner' },
      }),
    );
  });

  it('отказ не пишет событие допуска', async () => {
    const { service, auditService } = build({
      user: { id: 'u-2', role: 'member' },
    });

    await service.assertAllowed(WORKSPACE, 'x@tessera.com').catch(() => null);

    expect(auditService.log).not.toHaveBeenCalled();
  });
});

describe('SsoEmergencyAccessService, отметка при старте', () => {
  it('включенный признак пишет системное событие', async () => {
    const { service, auditService } = build();

    await service.onApplicationBootstrap();

    expect(auditService.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'system.emergency_access_enabled',
        resourceType: 'workspace',
      }),
      // Контекст собирается явно: при старте запроса нет и CLS пуст.
      { workspaceId: 'ws-1', actorType: 'system' },
    );
  });

  it('выключенный признак не пишет ничего', async () => {
    const { service, auditService } = build({ enabled: false });

    await service.onApplicationBootstrap();

    expect(auditService.logWithContext).not.toHaveBeenCalled();
  });

  // Отметка в журнале не должна мешать запуску приложения.
  it('сбой записи не роняет старт', async () => {
    const { service, auditService } = build();
    auditService.logWithContext.mockRejectedValue(
      new Error('очередь недоступна'),
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
