import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ScimTokenService } from './scim-token.service';
import WorkspaceAbilityFactory from '../../../core/casl/abilities/workspace-ability.factory';
import { SCIM_TOKEN_PREFIX } from '../scim-token.util';

const WORKSPACE = { id: 'ws-1' } as any;
const OWNER = { id: 'owner-1', role: 'owner' } as any;
const MEMBER = { id: 'member-1', role: 'member' } as any;

function build(options: { active?: number; updated?: number } = {}) {
  const created: any[] = [];
  const scimTokenRepo: any = {
    listPaginated: jest.fn(async () => ({ items: [], meta: {} })),
    countActive: jest.fn(async () => ({ count: options.active ?? 0 })),
    create: jest.fn(async (values: any) => {
      created.push(values);
      return { ...values, id: 'token-1' };
    }),
    rename: jest.fn(async () => ({
      numUpdatedRows: BigInt(options.updated ?? 1),
    })),
    revoke: jest.fn(async () => ({
      numUpdatedRows: BigInt(options.updated ?? 1),
    })),
  };
  const auditService: any = { log: jest.fn() };

  const service = new ScimTokenService(
    scimTokenRepo,
    new WorkspaceAbilityFactory(),
    auditService,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});

  return { service, scimTokenRepo, auditService, created };
}

describe('ScimTokenService, права', () => {
  it('участнику без прав администратора отказано во всех действиях', async () => {
    const { service } = build();

    await expect(
      service.list({ limit: 20 } as any, MEMBER, WORKSPACE),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.create({ name: 'x' }, MEMBER, WORKSPACE),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.update({ tokenId: 't', name: 'x' } as any, MEMBER, WORKSPACE),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.revoke('t', MEMBER, WORKSPACE)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('ScimTokenService, создание', () => {
  it('значение возвращается один раз, хеш наружу не уходит', async () => {
    const { service, created } = build();

    const result: any = await service.create(
      { name: 'Okta' },
      OWNER,
      WORKSPACE,
    );

    expect(result.token.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
    expect(result.tokenHash).toBeUndefined();
    // В базу уходит хеш, а не значение.
    expect(created[0].tokenHash).toHaveLength(64);
    expect(created[0].tokenHash).not.toBe(result.token);
    expect(created[0].tokenLastFour).toBe(result.token.slice(-4));
  });

  it('пишется событие журнала', async () => {
    const { service, auditService } = build();

    await service.create({ name: 'Okta' }, OWNER, WORKSPACE);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'scim_token.created',
        resourceType: 'scim_token',
        resourceId: 'token-1',
      }),
    );
  });

  // Накопление токенов без предела делает отзыв доступа невозможным:
  // непонятно, какой из них заводил уволенный администратор.
  it('предел действующих токенов не обходится', async () => {
    const { service, auditService } = build({ active: 10 });

    await expect(
      service.create({ name: 'еще один' }, OWNER, WORKSPACE),
    ).rejects.toMatchObject({ response: { code: 'error.scim.token_limit' } });
    expect(auditService.log).not.toHaveBeenCalled();
  });
});

describe('ScimTokenService, изменение и отзыв', () => {
  it('переименование пишет событие', async () => {
    const { service, auditService } = build();

    await expect(
      service.update({ tokenId: 't-1', name: 'новое' }, OWNER, WORKSPACE),
    ).resolves.toEqual({ success: true });

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scim_token.updated' }),
    );
  });

  it('отзыв пишет событие', async () => {
    const { service, auditService } = build();

    await expect(service.revoke('t-1', OWNER, WORKSPACE)).resolves.toEqual({
      success: true,
    });

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scim_token.deleted' }),
    );
  });

  it('несуществующий токен дает отказ, а не молчаливый успех', async () => {
    const { service, auditService } = build({ updated: 0 });

    await expect(
      service.update({ tokenId: 'нет', name: 'x' }, OWNER, WORKSPACE),
    ).rejects.toThrow(NotFoundException);
    await expect(service.revoke('нет', OWNER, WORKSPACE)).rejects.toThrow(
      NotFoundException,
    );
    expect(auditService.log).not.toHaveBeenCalled();
  });
});
