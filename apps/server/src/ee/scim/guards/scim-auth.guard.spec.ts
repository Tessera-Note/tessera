import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ScimAuthGuard } from './scim-auth.guard';
import { generateScimToken, hashScimToken } from '../scim-token.util';

const { token: VALID_TOKEN } = generateScimToken();

function build(options: { record?: any; workspace?: any } = {}) {
  const scimTokenRepo: any = {
    findActiveByHash: jest.fn(async () =>
      'record' in options ? options.record : { id: 'token-1' },
    ),
    touchLastUsed: jest.fn(async () => undefined),
  };

  const auditService: any = { setActorType: jest.fn() };

  const guard = new ScimAuthGuard(scimTokenRepo, auditService);
  jest.spyOn((guard as any).logger, 'warn').mockImplementation(() => {});

  const workspace =
    'workspace' in options
      ? options.workspace
      : { id: 'ws-1', isScimEnabled: true };

  const request: any = { headers: {}, raw: { workspace } };
  const context: any = { switchToHttp: () => ({ getRequest: () => request }) };

  return { guard, context, request, scimTokenRepo, auditService };
}

describe('ScimAuthGuard, заголовок', () => {
  it('действующий токен пропускается', async () => {
    const { guard, context, request } = build();
    request.headers.authorization = `Bearer ${VALID_TOKEN}`;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.scimToken).toEqual({ id: 'token-1' });
  });

  it('отсутствующий заголовок отвергается', async () => {
    const { guard, context } = build();

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('чужая схема авторизации отвергается', async () => {
    const { guard, context, request } = build();
    request.headers.authorization = `Basic ${VALID_TOKEN}`;

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('пустое значение после Bearer отвергается', async () => {
    const { guard, context, request } = build();
    request.headers.authorization = 'Bearer   ';

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('схема разбирается без учета регистра', async () => {
    const { guard, context, request } = build();
    request.headers.authorization = `bearer ${VALID_TOKEN}`;

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

describe('ScimAuthGuard, токен', () => {
  it('в базе ищется хеш, а не само значение', async () => {
    const { guard, context, request, scimTokenRepo } = build();
    request.headers.authorization = `Bearer ${VALID_TOKEN}`;

    await guard.canActivate(context);

    expect(scimTokenRepo.findActiveByHash).toHaveBeenCalledWith(
      hashScimToken(VALID_TOKEN),
      'ws-1',
    );
  });

  // Отозванный токен не проходит фильтры запроса и не находится.
  it('ненайденный токен отвергается', async () => {
    const { guard, context, request } = build({ record: undefined });
    request.headers.authorization = `Bearer ${VALID_TOKEN}`;

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // Пространство участвует в запросе, поэтому чужой токен не находится.
  it('поиск ограничен пространством запроса', async () => {
    const { guard, context, request, scimTokenRepo } = build({
      workspace: { id: 'ws-2', isScimEnabled: true },
    });
    request.headers.authorization = `Bearer ${VALID_TOKEN}`;

    await guard.canActivate(context);

    expect(scimTokenRepo.findActiveByHash.mock.calls[0][1]).toBe('ws-2');
  });

  it('успешная проверка отмечает время использования', async () => {
    const { guard, context, request, scimTokenRepo } = build();
    request.headers.authorization = `Bearer ${VALID_TOKEN}`;

    await guard.canActivate(context);

    expect(scimTokenRepo.touchLastUsed).toHaveBeenCalledWith('token-1');
  });
});

describe('ScimAuthGuard, состояние пространства', () => {
  it('выключенный SCIM отвергает даже действующий токен', async () => {
    const { guard, context, request, scimTokenRepo } = build({
      workspace: { id: 'ws-1', isScimEnabled: false },
    });
    request.headers.authorization = `Bearer ${VALID_TOKEN}`;

    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
    expect(scimTokenRepo.findActiveByHash).not.toHaveBeenCalled();
  });

  it('неопределенное пространство отвергается', async () => {
    const { guard, context, request } = build({ workspace: undefined });
    request.headers.authorization = `Bearer ${VALID_TOKEN}`;

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

/**
 * Автор изменений от каталога это интеграция, а не человек. Отметка ставится
 * в guard, чтобы ее унаследовали и события, которые пишут переиспользуемые
 * сервисы приложения из своего кода.
 */
describe('ScimAuthGuard, автор в журнале', () => {
  it('успешная аутентификация помечает автора как интеграцию', async () => {
    const { guard, context, request, auditService } = build();
    request.headers.authorization = `Bearer ${VALID_TOKEN}`;

    await guard.canActivate(context);

    expect(auditService.setActorType).toHaveBeenCalledWith('api_key');
  });

  it('при отказе отметка не ставится', async () => {
    const { guard, context, request, auditService } = build({ record: null });
    request.headers.authorization = `Bearer ${VALID_TOKEN}`;

    await guard.canActivate(context).catch(() => null);

    expect(auditService.setActorType).not.toHaveBeenCalled();
  });
});
