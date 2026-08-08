import { SamlRequestCache } from './saml-request-cache.service';

/**
 * Хранилище идентификаторов выданных запросов SAML.
 *
 * Контракт задан библиотекой и неочевиден: `saveAsync` обязан вернуть `null`
 * на занятом ключе, `getAsync` вернуть ровно сохраненную строку, а
 * `removeAsync` принять `null`. Отступление молча ломает сверку, потому что
 * возвращаемые значения библиотека частью игнорирует, а частью разбирает.
 */
function build() {
  const calls: any[] = [];
  const redis: any = {
    set: jest.fn(async (...args: any[]) => {
      calls.push(args);
      return redis.__setResult;
    }),
    get: jest.fn(async () => redis.__getResult),
    del: jest.fn(async () => redis.__delResult),
    __setResult: 'OK',
    __getResult: null,
    __delResult: 1,
  };

  const service = new SamlRequestCache({ getOrThrow: () => redis } as any);
  return { service, redis, calls };
}

const TTL = 600_000;

describe('SamlRequestCache, сохранение', () => {
  it('ключ содержит провайдера и идентификатор запроса', async () => {
    const { service, calls } = build();

    await service.forProvider('prov-1', TTL).saveAsync('_abc', 'момент');

    expect(calls[0][0]).toBe('saml:req:prov-1:_abc');
  });

  it('срок жизни передается в миллисекундах', async () => {
    const { service, calls } = build();

    await service.forProvider('prov-1', TTL).saveAsync('_abc', 'момент');

    expect(calls[0].slice(1)).toEqual(['момент', 'PX', TTL, 'NX']);
  });

  it('успешная вставка возвращает запись', async () => {
    const { service } = build();

    const item = await service
      .forProvider('prov-1', TTL)
      .saveAsync('_abc', 'момент');

    expect(item).toEqual({
      value: 'момент',
      createdAt: expect.any(Number),
    });
  });

  // Контракт библиотеки: занятый ключ означает null, а не исключение.
  it('занятый ключ возвращает null', async () => {
    const { service, redis } = build();
    redis.__setResult = null;

    await expect(
      service.forProvider('prov-1', TTL).saveAsync('_abc', 'момент'),
    ).resolves.toBeNull();
  });
});

describe('SamlRequestCache, чтение', () => {
  it('возвращается ровно сохраненная строка', async () => {
    const { service, redis } = build();
    redis.__getResult = '2026-08-07T14:00:00.000Z';

    await expect(
      service.forProvider('prov-1', TTL).getAsync('_abc'),
    ).resolves.toBe('2026-08-07T14:00:00.000Z');
  });

  it('промах возвращает null', async () => {
    const { service } = build();

    await expect(
      service.forProvider('prov-1', TTL).getAsync('_abc'),
    ).resolves.toBeNull();
  });

  it('чтение идет по тому же ключу, что и запись', async () => {
    const { service, redis } = build();

    await service.forProvider('prov-2', TTL).getAsync('_xyz');

    expect(redis.get).toHaveBeenCalledWith('saml:req:prov-2:_xyz');
  });
});

describe('SamlRequestCache, снятие', () => {
  it('снятие существующего ключа возвращает его', async () => {
    const { service } = build();

    await expect(
      service.forProvider('prov-1', TTL).removeAsync('_abc'),
    ).resolves.toBe('_abc');
  });

  it('снятие отсутствующего ключа возвращает null', async () => {
    const { service, redis } = build();
    redis.__delResult = 0;

    await expect(
      service.forProvider('prov-1', TTL).removeAsync('_abc'),
    ).resolves.toBeNull();
  });

  // Библиотека вызывает снятие и тогда, когда идентификатора в ответе не было.
  it('пустой ключ не доходит до Redis', async () => {
    const { service, redis } = build();

    await expect(
      service.forProvider('prov-1', TTL).removeAsync(null),
    ).resolves.toBeNull();
    expect(redis.del).not.toHaveBeenCalled();
  });
});

describe('SamlRequestCache, разделение провайдеров', () => {
  it('одинаковый идентификатор у разных провайдеров дает разные ключи', async () => {
    const { service, calls } = build();

    await service.forProvider('prov-1', TTL).saveAsync('_один', 'момент');
    await service.forProvider('prov-2', TTL).saveAsync('_один', 'момент');

    expect(calls[0][0]).not.toBe(calls[1][0]);
  });
});
