import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MfaService } from './mfa.service';
import WorkspaceAbilityFactory from '../../../core/casl/abilities/workspace-ability.factory';
import { UserRole } from '../../../common/helpers/types/permission';
import { AuditEvent } from '../../../common/events/audit-events';

const WORKSPACE = { id: 'ws-1', name: 'Tessera', enforceMfa: false } as any;
const TARGET = {
  id: 'target-1',
  email: 'target@example.com',
  name: 'Целевой',
  workspaceId: 'ws-1',
} as any;

// Заглушка шаблонов писем в jest отдает только экспорт по умолчанию, а
// этому тесту нужен вызываемый шаблон: без него письмо не собирается,
// ошибка гасится обработчиком в сервисе, и проверка отправки молчит.
jest.mock('@tessera/transactional/emails/mfa-reset-email', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../../../common/helpers', () => ({
  comparePasswordHash: jest.fn(async () => true),
}));

function build(
  options: { record?: any; target?: any; mailThrows?: boolean } = {},
) {
  const deleted: string[] = [];
  const audit: any[] = [];
  const mails: any[] = [];

  const chain: any = {
    selectAll: () => chain,
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () =>
      'record' in options
        ? options.record
        : { id: 'rec-1', isEnabled: true, method: 'totp' },
  };
  const db: any = {
    selectFrom: () => chain,
    deleteFrom: () => {
      const del: any = {
        where: (_col: string, _op: string, value: string) => {
          deleted.push(value);
          return del;
        },
        execute: async () => [],
      };
      return del;
    },
  };

  const userRepo: any = {
    findById: jest
      .fn()
      .mockResolvedValue('target' in options ? options.target : TARGET),
  };
  const mailService: any = {
    sendToQueue: jest.fn(async (mail: any) => {
      if (options.mailThrows) throw new Error('почта недоступна');
      mails.push(mail);
    }),
  };
  const auditService: any = {
    log: jest.fn((payload: any) => audit.push(payload)),
  };

  const service = new MfaService(
    db,
    userRepo,
    { getAppSecret: () => 'секрет', isHttps: () => false } as any,
    { verifyJwt: jest.fn() } as any,
    { createSessionAndToken: jest.fn() } as any,
    mailService,
    new WorkspaceAbilityFactory(),
    auditService,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  return { service, deleted, audit, mails };
}

const actorWith = (role: string) => ({ id: 'actor-1', role }) as any;

describe('MfaService, сброс администратором', () => {
  it.each([[UserRole.OWNER], [UserRole.ADMIN]])(
    'роль %s сбрасывает фактор',
    async (role) => {
      const { service, deleted } = build();

      const result = await service.resetForUser(
        'target-1',
        actorWith(role),
        WORKSPACE,
      );

      expect(result).toEqual({ success: true });
      expect(deleted).toContain('rec-1');
    },
  );

  it('участник сбросить не может', async () => {
    const { service, deleted } = build();

    await expect(
      service.resetForUser('target-1', actorWith(UserRole.MEMBER), WORKSPACE),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleted).toHaveLength(0);
  });

  // Отдельное событие, а не общее «изменен пользователь»: сброс чужого
  // второго фактора должен быть различим в журнале без разбора полей.
  it('пишется отдельное событие аудита', async () => {
    const { service, audit } = build();

    await service.resetForUser('target-1', actorWith(UserRole.ADMIN), WORKSPACE);

    expect(audit).toHaveLength(1);
    expect(audit[0].event).toBe(AuditEvent.USER_MFA_RESET);
    expect(audit[0].resourceId).toBe('target-1');
  });

  it('пользователю уходит письмо на его почту', async () => {
    const { service, mails } = build();

    await service.resetForUser('target-1', actorWith(UserRole.ADMIN), WORKSPACE);

    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('target@example.com');
  });

  // Неудача почты оставила бы пользователя запертым.
  it('недоставленное письмо не отменяет сброс', async () => {
    const { service, deleted } = build({ mailThrows: true });

    await expect(
      service.resetForUser('target-1', actorWith(UserRole.ADMIN), WORKSPACE),
    ).resolves.toEqual({ success: true });
    expect(deleted).toContain('rec-1');
  });

  it('несуществующий пользователь дает отказ', async () => {
    const { service, deleted } = build({ target: undefined });

    await expect(
      service.resetForUser('нет-такого', actorWith(UserRole.ADMIN), WORKSPACE),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deleted).toHaveLength(0);
  });

  it('без подключенного фактора сбрасывать нечего', async () => {
    const { service, audit } = build({ record: undefined });

    await expect(
      service.resetForUser('target-1', actorWith(UserRole.ADMIN), WORKSPACE),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(audit).toHaveLength(0);
  });

  // Сброс снимает фактор и не включает его заново: новый секрет заводит
  // сам пользователь, иначе администратор знал бы чужой секрет.
  it('запись удаляется целиком, а не отключается', async () => {
    const { service, deleted } = build();

    await service.resetForUser('target-1', actorWith(UserRole.ADMIN), WORKSPACE);

    expect(deleted).toEqual(['rec-1']);
  });
});
