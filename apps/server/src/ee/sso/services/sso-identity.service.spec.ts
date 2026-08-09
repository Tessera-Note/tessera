import { BadRequestException } from '@nestjs/common';
import { SsoIdentityService } from './sso-identity.service';

/**
 * Поиск включенного провайдера нужного типа.
 *
 * Остальное поведение общего сервиса проверяется через `oidc.service.spec.ts`,
 * который собирает его настоящим. Здесь только отбор провайдера: тип попадает
 * в запрос из сервиса протокола, и ошибка в нем открыла бы вход по чужим
 * настройкам.
 */
function build(provider: any) {
  const conditions: Array<[string, string, unknown]> = [];

  const chain: any = {
    selectAll: () => chain,
    select: () => chain,
    where: (...args: [string, string, unknown]) => {
      conditions.push(args);
      return chain;
    },
    executeTakeFirst: async () => provider,
  };

  const db: any = { selectFrom: () => chain };
  // Синхронизация групп в этих проверках не участвует.
  const service = new SsoIdentityService(
    db,
    {} as any,
    {} as any,
    {} as any,
    { sync: jest.fn(async () => {}) } as any,
  );

  return { service, conditions };
}

describe('SsoIdentityService, отбор провайдера', () => {
  it('провайдер возвращается, когда найден', async () => {
    const { service } = build({ id: 'prov-1', type: 'saml' });

    await expect(
      service.findEnabledProvider('prov-1', 'ws-1', 'saml'),
    ).resolves.toEqual({ id: 'prov-1', type: 'saml' });
  });

  it('отсутствие провайдера дает отказ, а не пустой результат', async () => {
    const { service } = build(undefined);

    await expect(
      service.findEnabledProvider('prov-1', 'ws-1', 'saml'),
    ).rejects.toThrow(BadRequestException);
  });

  // Тип, пространство, включенность и мягкое удаление проверяются запросом.
  it('запрос ограничен типом, пространством, включенностью и удалением', async () => {
    const { service, conditions } = build({ id: 'prov-1' });

    await service.findEnabledProvider('prov-1', 'ws-1', 'saml');

    expect(conditions).toEqual([
      ['id', '=', 'prov-1'],
      ['workspaceId', '=', 'ws-1'],
      ['type', '=', 'saml'],
      ['isEnabled', '=', true],
      ['deletedAt', 'is', null],
    ]);
  });

  it('тип берется из аргумента, а не зашит', async () => {
    const { service, conditions } = build({ id: 'prov-1' });

    await service.findEnabledProvider('prov-1', 'ws-1', 'oidc');

    expect(conditions).toContainEqual(['type', '=', 'oidc']);
  });
});

/**
 * Совпадение по почте при уже существующей связи с тем же провайдером.
 *
 * Сюда попадают только когда поиск по идентификатору ничего не дал, значит
 * найденная связь заведена под другим идентификатором. Это либо смена
 * идентификатора у того же человека, либо адрес, переданный другому человеку.
 * Различить нельзя, поэтому перепривязка запрещена.
 */
function buildResolve(opts: { linked?: any; bound?: any; existing?: any }) {
  const inserted: any[] = [];

  const makeChain = (table: string): any => {
    const conditions: string[] = [];
    const chain: any = {
      selectAll: () => chain,
      select: () => chain,
      where: (column: string) => {
        conditions.push(column);
        return chain;
      },
      executeTakeFirst: async () => {
        if (table !== 'authAccounts') return undefined;
        // Поиск по идентификатору и поиск связи пользователя различаются
        // набором условий: во втором есть userId.
        return conditions.includes('userId') ? opts.bound : opts.linked;
      },
    };
    return chain;
  };

  const db: any = {
    selectFrom: (table: string) => makeChain(table),
    insertInto: () => ({
      values: (v: any) => {
        inserted.push(v);
        const builder: any = {
          execute: async () => [],
          onConflict: () => builder,
        };
        return builder;
      },
    }),
  };

  const userRepo: any = {
    findById: jest.fn(async () => ({ id: 'user-1' })),
    findByEmail: jest.fn(async () => opts.existing),
  };

  const service = new SsoIdentityService(
    db,
    userRepo,
    {} as any,
    {} as any,
    { sync: jest.fn(async () => {}) } as any,
  );
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

  return { service, inserted };
}

const RESOLVE_ARGS = {
  provider: { id: 'prov-1', allowSignup: true },
  workspace: { id: 'ws-1' } as any,
  subject: 'новый-идентификатор',
  email: 'petrov@tessera.com',
};

describe('SsoIdentityService, неоднозначное совпадение по почте', () => {
  it('пользователь с чужой связью того же провайдера не перепривязывается', async () => {
    const { service, inserted } = buildResolve({
      existing: { id: 'user-7' },
      bound: { providerUserId: 'прежний-идентификатор' },
    });

    await expect(service.resolveUser(RESOLVE_ARGS)).rejects.toMatchObject({
      response: { code: 'error.sso.identity_conflict' },
    });

    expect(inserted).toHaveLength(0);
  });

  // Первый вход через провайдера у человека, заведенного обычным способом.
  it('пользователь без связи с этим провайдером привязывается', async () => {
    const { service, inserted } = buildResolve({
      existing: { id: 'user-7' },
      bound: undefined,
    });

    await expect(service.resolveUser(RESOLVE_ARGS)).resolves.toEqual({
      id: 'user-7',
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual(
      expect.objectContaining({
        userId: 'user-7',
        authProviderId: 'prov-1',
        providerUserId: 'новый-идентификатор',
      }),
    );
  });
});
