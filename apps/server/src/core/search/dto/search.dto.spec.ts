import { validate } from 'class-validator';
import { SearchDTO, SearchShareDTO, SearchSuggestionDTO } from './search.dto';

describe('search DTO validation', () => {
  it.each([0, -1, 1.5, 101])('rejects invalid search limit %s', async (limit) => {
    const dto = Object.assign(new SearchDTO(), { query: 'term', limit });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it.each([-1, 0.5])('rejects invalid search offset %s', async (offset) => {
    const dto = Object.assign(new SearchDTO(), { query: 'term', offset });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it.each([0, -1, 1.5, 26])(
    'rejects invalid suggestion limit %s',
    async (limit) => {
      const dto = Object.assign(new SearchSuggestionDTO(), {
        query: 'term',
        limit,
      });

      expect(await validate(dto)).not.toHaveLength(0);
    },
  );

  it.each([
    { limit: 1, offset: 0 },
    { limit: 100, offset: 0 },
  ])('accepts search boundary values %#', async ({ limit, offset }) => {
    const dto = Object.assign(new SearchDTO(), { query: 'term', limit, offset });

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([1, 25])('accepts suggestion boundary limit %s', async (limit) => {
    const dto = Object.assign(new SearchSuggestionDTO(), {
      query: 'term',
      limit,
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([1, 100])('accepts inherited share-search limit %s', async (limit) => {
    const dto = Object.assign(new SearchShareDTO(), {
      query: 'term',
      shareId: 'share-key',
      limit,
      offset: 0,
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([0, -1, 1.5, 101])(
    'rejects invalid inherited share-search limit %s',
    async (limit) => {
      const dto = Object.assign(new SearchShareDTO(), {
        query: 'term',
        shareId: 'share-key',
        limit,
      });

      expect(await validate(dto)).not.toHaveLength(0);
    },
  );

  it.each([-1, 0.5])(
    'rejects invalid inherited share-search offset %s',
    async (offset) => {
      const dto = Object.assign(new SearchShareDTO(), {
        query: 'term',
        shareId: 'share-key',
        offset,
      });

      expect(await validate(dto)).not.toHaveLength(0);
    },
  );
});
