import { SchemaCompatibilityService } from './schema-compatibility.service';

// Migrator создается внутри сервиса, поэтому подменяем его конструктор.
const getMigrations = jest.fn();
jest.mock('kysely', () => ({
  ...jest.requireActual('kysely'),
  Migrator: jest.fn().mockImplementation(() => ({ getMigrations })),
  FileMigrationProvider: jest.fn(),
}));

function build() {
  const service = new SchemaCompatibilityService({} as never);
  const exit = jest
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  const error = jest
    .spyOn((service as any).logger, 'error')
    .mockImplementation(() => undefined);
  return { service, exit, error };
}

/** Форма записи из Migrator.getMigrations. */
const known = (name: string, executed: boolean) => ({
  name,
  executedAt: executed ? new Date('2026-08-05T00:00:00.000Z') : undefined,
  migration: { up: async () => undefined },
});

const unknownInBuild = (name: string) => ({
  name,
  executedAt: new Date('2026-08-05T00:00:00.000Z'),
  migration: undefined,
});

describe('SchemaCompatibilityService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('пропускает совпадающую схему', async () => {
    const { service, exit } = build();
    getMigrations.mockResolvedValue([
      known('20260101T000000-a', true),
      known('20260102T000000-b', true),
    ]);

    await service.assertSchemaIsNotAhead();

    expect(exit).not.toHaveBeenCalled();
  });

  it('пропускает сборку новее базы', async () => {
    const { service, exit } = build();
    getMigrations.mockResolvedValue([
      known('20260101T000000-a', true),
      // есть в сборке, но еще не применена
      known('20260103T000000-c', false),
    ]);

    await service.assertSchemaIsNotAhead();

    expect(exit).not.toHaveBeenCalled();
  });

  // Ради этого случая модуль и заведен: старый код на новой схеме нарушает
  // ее ограничения и переходит в режим только чтения.
  it('останавливает запуск, если схема ушла вперед', async () => {
    const { service, exit, error } = build();
    getMigrations.mockResolvedValue([
      known('20260101T000000-a', true),
      unknownInBuild('20260805T170000-normalize-base-jsonb'),
    ]);

    await service.assertSchemaIsNotAhead();

    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0][0]).toContain(
      '20260805T170000-normalize-base-jsonb',
    );
  });

  it('перечисляет все лишние миграции', async () => {
    const { service, error } = build();
    getMigrations.mockResolvedValue([
      unknownInBuild('20260805T170000-первая'),
      unknownInBuild('20260805T180000-вторая'),
    ]);

    await service.assertSchemaIsNotAhead();

    expect(error.mock.calls[0][0]).toContain('20260805T170000-первая');
    expect(error.mock.calls[0][0]).toContain('20260805T180000-вторая');
  });

  it('не считает лишней неприменённую миграцию, которой нет в сборке', async () => {
    const { service, exit } = build();
    getMigrations.mockResolvedValue([
      { name: 'висячая', executedAt: undefined, migration: undefined },
    ]);

    await service.assertSchemaIsNotAhead();

    expect(exit).not.toHaveBeenCalled();
  });
});
