import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateTemplateDto,
  ListTemplatesDto,
  TemplateIdDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from './template.dto';

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const PAGE_ID = '33333333-3333-4333-8333-333333333333';

async function validatePayload<T extends object>(
  type: new () => T,
  payload: Record<string, unknown>,
) {
  const instance = plainToInstance(type, payload);
  const errors = await validate(instance);

  return { instance, errors };
}

describe('template DTOs', () => {
  describe('TemplateIdDto', () => {
    it('accepts a valid template UUID', async () => {
      const { errors } = await validatePayload(TemplateIdDto, {
        templateId: TEMPLATE_ID,
      });

      expect(errors).toHaveLength(0);
    });

    it('rejects a malformed template UUID', async () => {
      const { errors } = await validatePayload(TemplateIdDto, {
        templateId: 'not-a-uuid',
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('templateId');
    });
  });

  describe('ListTemplatesDto', () => {
    it('accepts an optional space UUID and inherits the default limit', async () => {
      const { instance, errors } = await validatePayload(ListTemplatesDto, {
        spaceId: SPACE_ID,
      });

      expect(errors).toHaveLength(0);
      expect(instance.limit).toBe(20);
    });

    it('rejects a malformed space UUID', async () => {
      const { errors } = await validatePayload(ListTemplatesDto, {
        spaceId: 'not-a-uuid',
      });

      expect(errors.some((error) => error.property === 'spaceId')).toBe(true);
    });

    it('enforces the inherited pagination limit maximum', async () => {
      const valid = await validatePayload(ListTemplatesDto, { limit: 100 });
      const invalid = await validatePayload(ListTemplatesDto, { limit: 101 });

      expect(valid.errors).toHaveLength(0);
      expect(invalid.errors.some((error) => error.property === 'limit')).toBe(
        true,
      );
    });
  });

  describe('CreateTemplateDto', () => {
    it('accepts a valid payload and trims the title', async () => {
      const content = {
        type: 'doc',
        content: [{ type: 'paragraph' }],
      };
      const { instance, errors } = await validatePayload(CreateTemplateDto, {
        title: '  Project brief  ',
        description: 'A reusable project brief',
        icon: 'file-text',
        content,
        spaceId: SPACE_ID,
      });

      expect(errors).toHaveLength(0);
      expect(instance.title).toBe('Project brief');
      expect(instance.content).toEqual(content);
    });

    it('rejects a whitespace-only title after transformation', async () => {
      const { instance, errors } = await validatePayload(CreateTemplateDto, {
        title: '   ',
      });

      expect(instance.title).toBe('');
      expect(errors.some((error) => error.property === 'title')).toBe(true);
    });

    it('rejects fields that exceed their maximum lengths', async () => {
      const { errors } = await validatePayload(CreateTemplateDto, {
        title: 't'.repeat(256),
        description: 'd'.repeat(2001),
        icon: 'i'.repeat(256),
      });

      expect(errors.map((error) => error.property)).toEqual(
        expect.arrayContaining(['title', 'description', 'icon']),
      );
    });

    it('rejects a malformed optional space UUID', async () => {
      const { errors } = await validatePayload(CreateTemplateDto, {
        title: 'Project brief',
        spaceId: 'not-a-uuid',
      });

      expect(errors.some((error) => error.property === 'spaceId')).toBe(true);
    });

    it('rejects non-object content', async () => {
      const { errors } = await validatePayload(CreateTemplateDto, {
        title: 'Project brief',
        content: 'not-an-object',
      });

      expect(errors.some((error) => error.property === 'content')).toBe(true);
    });
  });

  describe('UpdateTemplateDto', () => {
    it('accepts a template UUID with a partial mutable payload', async () => {
      const { errors } = await validatePayload(UpdateTemplateDto, {
        templateId: TEMPLATE_ID,
        description: 'Updated description',
        content: { type: 'doc' },
      });

      expect(errors).toHaveLength(0);
    });

    it('requires a valid template UUID', async () => {
      const missing = await validatePayload(UpdateTemplateDto, {
        title: 'Updated title',
      });
      const malformed = await validatePayload(UpdateTemplateDto, {
        templateId: 'not-a-uuid',
      });

      expect(
        missing.errors.some((error) => error.property === 'templateId'),
      ).toBe(true);
      expect(
        malformed.errors.some((error) => error.property === 'templateId'),
      ).toBe(true);
    });

    it.each(['title', 'description', 'content'])(
      'rejects an explicit null %s',
      async (property) => {
        const { errors } = await validatePayload(UpdateTemplateDto, {
          templateId: TEMPLATE_ID,
          [property]: null,
        });

        expect(errors.some((error) => error.property === property)).toBe(true);
      },
    );

    it('accepts an explicit null icon', async () => {
      const { instance, errors } = await validatePayload(UpdateTemplateDto, {
        templateId: TEMPLATE_ID,
        icon: null,
      });

      expect(errors).toHaveLength(0);
      expect(instance.icon).toBeNull();
    });

    it.each([42, false, {}, []])(
      'rejects a non-string non-null icon value: %p',
      async (icon) => {
        const { errors } = await validatePayload(UpdateTemplateDto, {
          templateId: TEMPLATE_ID,
          icon,
        });

        expect(errors.some((error) => error.property === 'icon')).toBe(true);
      },
    );

    it('rejects an icon longer than 255 characters', async () => {
      const { errors } = await validatePayload(UpdateTemplateDto, {
        templateId: TEMPLATE_ID,
        icon: 'i'.repeat(256),
      });

      expect(errors.some((error) => error.property === 'icon')).toBe(true);
    });

    it('accepts a null spaceId to move a template to global scope', async () => {
      const { errors } = await validatePayload(UpdateTemplateDto, {
        templateId: TEMPLATE_ID,
        spaceId: null,
      });

      expect(errors).toHaveLength(0);
    });

    it('rejects a malformed non-null spaceId', async () => {
      const { errors } = await validatePayload(UpdateTemplateDto, {
        templateId: TEMPLATE_ID,
        spaceId: 'not-a-uuid',
      });

      expect(errors.some((error) => error.property === 'spaceId')).toBe(true);
    });
  });

  describe('UseTemplateDto', () => {
    it('accepts valid required UUIDs and an optional parent page UUID', async () => {
      const { errors } = await validatePayload(UseTemplateDto, {
        templateId: TEMPLATE_ID,
        spaceId: SPACE_ID,
        parentPageId: PAGE_ID,
      });

      expect(errors).toHaveLength(0);
    });

    it.each(['templateId', 'spaceId', 'parentPageId'])(
      'rejects a malformed %s',
      async (property) => {
        const payload = {
          templateId: TEMPLATE_ID,
          spaceId: SPACE_ID,
          parentPageId: PAGE_ID,
          [property]: 'not-a-uuid',
        };
        const { errors } = await validatePayload(UseTemplateDto, payload);

        expect(errors.some((error) => error.property === property)).toBe(true);
      },
    );
  });
});
