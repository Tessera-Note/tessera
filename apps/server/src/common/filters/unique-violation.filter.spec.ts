import { BadRequestException, ConflictException } from '@nestjs/common';
import { UniqueViolationFilter } from './unique-violation.filter';

/**
 * Пути создания объекта с уникальным именем читают базу, проверяют занятость,
 * потом вставляют. Между проверкой и вставкой ничего не держится, и при
 * одновременном создании второй запрос получает от Postgres 23505, а Нест
 * отдает 500: человек видит поломку там, где по смыслу «имя занято».
 *
 * Фильтр один на все такие пути, поэтому проверяется именно он, а не каждый
 * путь по отдельности.
 */
function build() {
  const filter = new UniqueViolationFilter({} as any);
  jest.spyOn((filter as any).logger, 'warn').mockImplementation(() => {});
  const handled: unknown[] = [];

  // Все, что не 23505, обязано уходить дальше нетронутым.
  jest
    .spyOn(Object.getPrototypeOf(UniqueViolationFilter.prototype), 'catch')
    .mockImplementation((exception: unknown) => {
      handled.push(exception);
    });

  return { filter, handled };
}

const hostOf = (type: string) => ({ getType: () => type }) as any;
const HOST = hostOf('http');

describe('UniqueViolationFilter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('нарушение уникальности превращается в отказ, а не в поломку', () => {
    const { filter, handled } = build();

    filter.catch(
      { code: '23505', constraint: 'groups_name_workspace_id_unique' },
      HOST,
    );

    expect(handled[0]).toBeInstanceOf(ConflictException);
    expect((handled[0] as ConflictException).message).toBe(
      'A group with this name already exists',
    );
  });

  /** Имя ограничения наружу не отдается: оно про устройство базы. */
  it('неизвестное ограничение дает общий текст без имени ограничения', () => {
    const { filter, handled } = build();

    filter.catch({ code: '23505', constraint: 'какое_то_новое_unique' }, HOST);

    const message = (handled[0] as ConflictException).message;
    expect(message).toBe('This record already exists');
    expect(message).not.toContain('unique');
  });

  it('ограничение без имени тоже дает отказ', () => {
    const { filter, handled } = build();

    filter.catch({ code: '23505' }, HOST);

    expect(handled[0]).toBeInstanceOf(ConflictException);
  });

  it('прочие ошибки базы уходят дальше нетронутыми', () => {
    const { filter, handled } = build();
    const foreignKey = { code: '23503', constraint: 'какой_то_fkey' };

    filter.catch(foreignKey, HOST);

    expect(handled[0]).toBe(foreignKey);
  });

  it('исключения приложения не подменяются', () => {
    const { filter, handled } = build();
    const original = new BadRequestException('Provide a user or a group');

    filter.catch(original, HOST);

    expect(handled[0]).toBe(original);
  });

  /**
   * Фильтр объявлен без ограничения по типу исключения, поэтому он видит и
   * сокет, и очередь. Там ответа с кодом состояния нет, и подменять ошибку
   * нечем.
   */
  it('вне HTTP ошибка не подменяется', () => {
    const { filter, handled } = build();
    const violation = {
      code: '23505',
      constraint: 'groups_name_workspace_id_unique',
    };

    filter.catch(violation, hostOf('ws'));

    expect(handled[0]).toBe(violation);
  });

  it('ошибка без кода уходит дальше нетронутой', () => {
    const { filter, handled } = build();
    const plain = new Error('что-то другое');

    filter.catch(plain, HOST);

    expect(handled[0]).toBe(plain);
  });
});
