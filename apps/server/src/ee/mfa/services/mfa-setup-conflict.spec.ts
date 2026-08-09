import { BadRequestException } from '@nestjs/common';
import { MfaService } from './mfa.service';
import WorkspaceAbilityFactory from '../../../core/casl/abilities/workspace-ability.factory';

/**
 * Настройка второго фактора читала запись, а затем ветвилась на update или
 * insert. Между чтением и записью ничего не держалось, и два одновременных
 * вызова получали 23505 на единственной строке пользователя.
 *
 * Одна вставка с обработкой конфликта закрывает и это, и более неприятный
 * случай: если фактор успели подключить между чтением и записью, подключенный
 * секрет не затирается, а человек узнает об этом отказом, а не рабочим на вид
 * QR-кодом с секретом, которого в базе нет.
 */
const USER = { id: 'u-1', email: 'u@example.com' } as any;
const WORKSPACE = { id: 'ws-1', name: 'Tessera' } as any;

function build(options: { existing?: any; stored?: any } = {}) {
  const conflict: { constraint?: string; guarded?: boolean } = {};

  const selectChain: any = {
    selectAll: () => selectChain,
    select: () => selectChain,
    where: () => selectChain,
    executeTakeFirst: async () => options.existing,
  };

  const insertChain: any = {
    values: () => insertChain,
    onConflict: (cb: any) => {
      cb({
        constraint: (name: string) => {
          conflict.constraint = name;
          return {
            doUpdateSet: () => ({
              where: () => {
                conflict.guarded = true;
                return {};
              },
            }),
          };
        },
      });
      return insertChain;
    },
    returning: () => insertChain,
    executeTakeFirst: async () =>
      'stored' in options ? options.stored : { id: 'rec-1' },
  };

  const db: any = {
    selectFrom: () => selectChain,
    insertInto: () => insertChain,
  };

  const service = new MfaService(
    db,
    { findById: jest.fn() } as any,
    {
      getAppSecret: () => 'секрет',
      isHttps: () => false,
      isCloud: () => false,
    } as any,
    { verifyJwt: jest.fn() } as any,
    { createSessionAndToken: jest.fn() } as any,
    { sendToQueue: jest.fn() } as any,
    new WorkspaceAbilityFactory(),
    { log: jest.fn() } as any,
  );

  return { service, conflict };
}

describe('MfaService.setup, одновременные вызовы', () => {
  it('запись идет одной вставкой с обработкой конфликта', async () => {
    const { service, conflict } = build();

    await service.setup(USER, WORKSPACE);

    expect(conflict.constraint).toBe('user_mfa_user_id_unique');
    expect(conflict.guarded).toBe(true);
  });

  it('первая настройка выдает код и ключ для ручного ввода', async () => {
    const { service } = build();

    const result = await service.setup(USER, WORKSPACE);

    expect(result.method).toBe('totp');
    expect(result.qrCode).toContain('data:image');
    expect(result.manualKey).toEqual(expect.any(String));
  });

  it('незавершенная попытка заменяется новой', async () => {
    const { service } = build({ existing: { id: 'rec-1', isEnabled: false } });

    await expect(service.setup(USER, WORKSPACE)).resolves.toMatchObject({
      method: 'totp',
    });
  });

  it('подключенный фактор настроить заново нельзя', async () => {
    const { service } = build({ existing: { id: 'rec-1', isEnabled: true } });

    await expect(service.setup(USER, WORKSPACE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * Фактор подключили между чтением и записью: условие на `is_enabled` не дало
   * затереть секрет, вставка ничего не вернула.
   */
  it('гонка с подключением дает отказ, а не чужой секрет', async () => {
    const { service } = build({ existing: undefined, stored: undefined });

    await expect(service.setup(USER, WORKSPACE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
