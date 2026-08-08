import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { MfaService } from './mfa.service';

const USER = { id: 'user-1', workspaceId: 'ws-1' } as any;

jest.mock('../../../common/helpers', () => ({
  comparePasswordHash: jest.fn(
    async (plain: string) => plain === 'верный-пароль',
  ),
}));

function build(options: { record?: any } = {}) {
  const updates: any[] = [];

  const chain: any = {
    selectAll: () => chain,
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () =>
      'record' in options ? options.record : { id: 'rec-1', isEnabled: true },
  };
  const db: any = {
    selectFrom: () => chain,
    updateTable: () => {
      const upd: any = {
        set: (values: any) => {
          updates.push(values);
          return upd;
        },
        where: () => upd,
        execute: async () => [],
      };
      return upd;
    },
  };

  const userRepo: any = {
    findById: jest.fn().mockResolvedValue({ ...USER, password: 'хеш' }),
  };
  const service = new MfaService(
    db,
    userRepo,
    { getAppSecret: () => 'секрет', isHttps: () => false } as any,
    { verifyJwt: jest.fn() } as any,
    { createSessionAndToken: jest.fn() } as any,
    { sendToQueue: jest.fn() } as any,
    { createForUser: jest.fn() } as any,
    { log: jest.fn() } as any,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
  return { service, updates };
}

describe('MfaService, перевыпуск резервных кодов', () => {
  it('выдается новый набор из десяти кодов', async () => {
    const { service } = build();

    const result = await service.regenerateBackupCodes(USER, 'верный-пароль');

    expect(result.backupCodes).toHaveLength(10);
  });

  // Прежние коды должны перестать работать той же операцией.
  it('набор заменяется целиком, а не дополняется', async () => {
    const { service, updates } = build({
      record: { id: 'rec-1', isEnabled: true, backupCodes: ['старый'] },
    });

    await service.regenerateBackupCodes(USER, 'верный-пароль');

    expect(updates[0].backupCodes).toHaveLength(10);
    expect(updates[0].backupCodes).not.toContain('старый');
  });

  it('в базу пишутся хеши, а не сами коды', async () => {
    const { service, updates } = build();

    const result = await service.regenerateBackupCodes(USER, 'верный-пароль');

    expect(updates[0].backupCodes.every((h: string) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(updates[0].backupCodes).not.toContain(result.backupCodes[0]);
  });

  // Перехваченная сессия не должна выдавать себе новый запасной путь.
  it('без пароля перевыпуск отвергается', async () => {
    const { service, updates } = build();

    await expect(
      service.regenerateBackupCodes(USER),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updates).toHaveLength(0);
  });

  it('неверный пароль отвергается', async () => {
    const { service, updates } = build();

    await expect(
      service.regenerateBackupCodes(USER, 'неверный'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updates).toHaveLength(0);
  });

  it('без подключенного фактора перевыпускать нечего', async () => {
    const { service } = build({ record: undefined });

    await expect(
      service.regenerateBackupCodes(USER, 'верный-пароль'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MfaService, предупреждение о малом остатке', () => {
  const statusWith = async (backupCodes: string[] | null, isEnabled = true) => {
    const { service } = build({
      record: { id: 'rec-1', isEnabled, method: 'totp', backupCodes },
    });
    return service.getStatus(USER);
  };

  it.each([
    [10, false],
    [4, false],
    [3, true],
    [1, true],
    [0, true],
  ])('при %i кодах признак малого остатка равен %s', async (count, expected) => {
    const status = await statusWith(Array(count).fill('хеш'));

    expect(status.backupCodesCount).toBe(count);
    expect(status.backupCodesLow).toBe(expected);
  });

  // Без подключенного фактора предупреждать не о чем.
  it('без фактора признак ложен', async () => {
    const status = await statusWith(Array(1).fill('хеш'), false);

    expect(status.backupCodesLow).toBe(false);
    expect(status.backupCodesCount).toBe(0);
  });

  it('отсутствие массива кодов считается нулем', async () => {
    const status = await statusWith(null);

    expect(status.backupCodesCount).toBe(0);
    expect(status.backupCodesLow).toBe(true);
  });
});
