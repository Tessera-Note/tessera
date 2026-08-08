import { ForbiddenException } from '@nestjs/common';
import { AuditController } from './audit.controller';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { UserRole } from '../../common/helpers/types/permission';

const WORKSPACE = { id: 'ws-1' } as any;

function build() {
  const auditService: any = {
    listLogs: jest.fn().mockResolvedValue({ items: [], meta: {} }),
    getRetention: jest.fn().mockResolvedValue({ retentionDays: 90 }),
    updateRetention: jest.fn().mockResolvedValue(undefined),
  };
  // Фабрика прав настоящая: подмена мокой не поймала бы расхождение
  // между ролью и реальными правами.
  const controller = new AuditController(
    auditService,
    new WorkspaceAbilityFactory(),
  );
  return { controller, auditService };
}

const userWith = (role: string) => ({ id: 'u-1', role }) as any;

describe('AuditController, доступ к журналу', () => {
  it.each([[UserRole.OWNER], [UserRole.ADMIN]])(
    'роль %s читает журнал',
    async (role) => {
      const { controller, auditService } = build();

      await controller.list({} as any, userWith(role), WORKSPACE);

      expect(auditService.listLogs).toHaveBeenCalledWith({}, 'ws-1');
    },
  );

  it('участник журнал не читает', async () => {
    const { controller, auditService } = build();

    expect(() =>
      controller.list({} as any, userWith(UserRole.MEMBER), WORKSPACE),
    ).toThrow(ForbiddenException);
    expect(auditService.listLogs).not.toHaveBeenCalled();
  });

  it('участник не читает срок хранения', () => {
    const { controller, auditService } = build();

    expect(() =>
      controller.getRetention(userWith(UserRole.MEMBER), WORKSPACE),
    ).toThrow(ForbiddenException);
    expect(auditService.getRetention).not.toHaveBeenCalled();
  });

  it('участник не меняет срок хранения', async () => {
    const { controller, auditService } = build();

    await expect(
      controller.updateRetention(
        { auditRetentionDays: 30 } as any,
        userWith(UserRole.MEMBER),
        WORKSPACE,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(auditService.updateRetention).not.toHaveBeenCalled();
  });

  it('администратор меняет срок и получает его обратно', async () => {
    const { controller, auditService } = build();

    const result = await controller.updateRetention(
      { auditRetentionDays: 30 } as any,
      userWith(UserRole.ADMIN),
      WORKSPACE,
    );

    expect(auditService.updateRetention).toHaveBeenCalledWith('ws-1', 30);
    expect(result).toEqual({ retentionDays: 90 });
  });

  // Выдача ограничена рабочим пространством из запроса, а не из тела:
  // иначе администратор одного пространства читал бы чужой журнал.
  it('пространство берется из контекста запроса, а не из тела', async () => {
    const { controller, auditService } = build();

    await controller.list(
      { spaceId: 'space-9' } as any,
      userWith(UserRole.ADMIN),
      WORKSPACE,
    );

    expect(auditService.listLogs).toHaveBeenCalledWith(
      { spaceId: 'space-9' },
      'ws-1',
    );
  });
});
