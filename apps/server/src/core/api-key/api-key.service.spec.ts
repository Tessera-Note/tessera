import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { UserRole } from '../../common/helpers/types/permission';

const KEY = {
  id: 'key-1',
  creatorId: 'user-1',
  workspaceId: 'ws-1',
};

function workspaceWith(restrict: boolean | undefined) {
  return {
    id: 'ws-1',
    settings:
      restrict === undefined ? {} : { api: { restrictToAdmins: restrict } },
  } as any;
}

function userWith(role: string) {
  return { id: 'user-1', role, deactivatedAt: null, deletedAt: null } as any;
}

function build(overrides: Record<string, any> = {}) {
  const apiKeyRepo = {
    create: jest.fn().mockResolvedValue(KEY),
    findActiveById: jest.fn().mockResolvedValue(KEY),
    touchLastUsed: jest.fn(),
    ...(overrides.apiKeyRepo ?? {}),
  };
  const userRepo = {
    findById: jest.fn().mockResolvedValue(userWith(UserRole.MEMBER)),
    ...(overrides.userRepo ?? {}),
  };
  const workspaceRepo = {
    findById: jest.fn().mockResolvedValue(workspaceWith(true)),
    ...(overrides.workspaceRepo ?? {}),
  };
  const tokenService = {
    generateApiToken: jest.fn().mockResolvedValue('токен'),
  };

  const service = new ApiKeyService(
    apiKeyRepo as any,
    userRepo as any,
    workspaceRepo as any,
    tokenService as any,
  );

  return { service, apiKeyRepo, userRepo, workspaceRepo, tokenService };
}

describe('ApiKeyService, ограничение доступа к API администраторами', () => {
  describe('выпуск ключа', () => {
    it('участник не может выпустить ключ при включенном ограничении', async () => {
      const { service, apiKeyRepo } = build();

      await expect(
        service.create(
          { name: 'ключ' } as any,
          userWith(UserRole.MEMBER),
          workspaceWith(true),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(apiKeyRepo.create).not.toHaveBeenCalled();
    });

    it.each([UserRole.ADMIN, UserRole.OWNER])(
      'роль %s выпускает ключ при включенном ограничении',
      async (role) => {
        const { service, apiKeyRepo } = build();

        await service.create(
          { name: 'ключ' } as any,
          userWith(role),
          workspaceWith(true),
        );

        expect(apiKeyRepo.create).toHaveBeenCalled();
      },
    );

    it('при выключенном ограничении участник выпускает ключ', async () => {
      const { service, apiKeyRepo } = build();

      await service.create(
        { name: 'ключ' } as any,
        userWith(UserRole.MEMBER),
        workspaceWith(false),
      );

      expect(apiKeyRepo.create).toHaveBeenCalled();
    });

    it('настройка без значения ограничением не считается', async () => {
      const { service, apiKeyRepo } = build();

      await service.create(
        { name: 'ключ' } as any,
        userWith(UserRole.MEMBER),
        workspaceWith(undefined),
      );

      expect(apiKeyRepo.create).toHaveBeenCalled();
    });
  });

  describe('использование ранее выпущенного ключа', () => {
    // Ради этой ветки проверка и стоит в двух местах: ключ, выданный до
    // включения настройки, иначе продолжал бы работать в обход нее.
    it('ключ участника перестает работать после включения ограничения', async () => {
      const { service, apiKeyRepo } = build({
        userRepo: {
          findById: jest.fn().mockResolvedValue(userWith(UserRole.MEMBER)),
        },
        workspaceRepo: {
          findById: jest.fn().mockResolvedValue(workspaceWith(true)),
        },
      });

      await expect(
        service.validateApiKey({
          apiKeyId: 'key-1',
          sub: 'user-1',
          workspaceId: 'ws-1',
        } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(apiKeyRepo.touchLastUsed).not.toHaveBeenCalled();
    });

    it('ключ администратора продолжает работать', async () => {
      const { service, apiKeyRepo } = build({
        userRepo: {
          findById: jest.fn().mockResolvedValue(userWith(UserRole.ADMIN)),
        },
      });

      const result = await service.validateApiKey({
        apiKeyId: 'key-1',
        sub: 'user-1',
        workspaceId: 'ws-1',
      } as any);

      expect(result.user.role).toBe(UserRole.ADMIN);
      expect(apiKeyRepo.touchLastUsed).toHaveBeenCalledWith('key-1', 'ws-1');
    });

    it('при выключенном ограничении ключ участника работает', async () => {
      const { service, apiKeyRepo } = build({
        workspaceRepo: {
          findById: jest.fn().mockResolvedValue(workspaceWith(false)),
        },
      });

      await service.validateApiKey({
        apiKeyId: 'key-1',
        sub: 'user-1',
        workspaceId: 'ws-1',
      } as any);

      expect(apiKeyRepo.touchLastUsed).toHaveBeenCalled();
    });

    it('чужой ключ отвергается раньше проверки ограничения', async () => {
      const { service } = build({
        apiKeyRepo: {
          findActiveById: jest
            .fn()
            .mockResolvedValue({ ...KEY, creatorId: 'другой' }),
        },
      });

      await expect(
        service.validateApiKey({
          apiKeyId: 'key-1',
          sub: 'user-1',
          workspaceId: 'ws-1',
        } as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
