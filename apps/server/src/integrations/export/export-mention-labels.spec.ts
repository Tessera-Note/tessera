import { ExportService } from './export.service';

/**
 * Имя человека записывается в узел упоминания при вставке и дальше не
 * меняется. Приложение показывает живое имя, а выгрузка отдавала замороженное,
 * поэтому имя удаленного участника уезжало наружу целиком, хотя в самой вики
 * оно уже было заменено.
 */
function build(rows: Array<{ id: string; name: string }>) {
  const service: ExportService = Object.create(ExportService.prototype);
  const chain: any = {
    select: () => chain,
    where: () => chain,
    execute: async () => rows,
  };
  (service as any).db = { selectFrom: () => chain };
  return service;
}

const doc = () => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Спросите ' },
        {
          type: 'mention',
          attrs: { entityType: 'user', entityId: 'u-1', label: 'Иван Петров' },
        },
        {
          type: 'mention',
          attrs: { entityType: 'page', entityId: 'p-1', label: 'Регламент' },
        },
      ],
    },
  ],
});

describe('ExportService.refreshUserMentionLabels', () => {
  it('имя удаленного участника заменяется на нынешнее', async () => {
    const service = build([{ id: 'u-1', name: 'Deleted user' }]);

    const result = await service.refreshUserMentionLabels(doc(), 'ws-1');

    expect(result.content[0].content[1].attrs.label).toBe('Deleted user');
  });

  /** Упоминание страницы к людям отношения не имеет и не трогается. */
  it('упоминание страницы остается как было', async () => {
    const service = build([{ id: 'u-1', name: 'Deleted user' }]);

    const result = await service.refreshUserMentionLabels(doc(), 'ws-1');

    expect(result.content[0].content[2].attrs.label).toBe('Регламент');
  });

  /**
   * Человека из другого пространства запрос не вернет, и выдумывать ему имя
   * нельзя: замороженное значение единственное, что о нем известно.
   */
  it('ненайденный человек сохраняет прежнее имя', async () => {
    const service = build([]);

    const result = await service.refreshUserMentionLabels(doc(), 'ws-1');

    expect(result.content[0].content[1].attrs.label).toBe('Иван Петров');
  });

  it('без упоминаний людей в базу не ходят', async () => {
    const service: ExportService = Object.create(ExportService.prototype);
    (service as any).db = {
      selectFrom: () => {
        throw new Error('лишний запрос');
      },
    };

    await expect(
      service.refreshUserMentionLabels(
        { type: 'doc', content: [{ type: 'paragraph' }] },
        'ws-1',
      ),
    ).resolves.toBeDefined();
  });

  /** Упоминание бывает и во вложенном узле, а не только в верхнем абзаце. */
  it('вложенные узлы обходятся', async () => {
    const service = build([{ id: 'u-1', name: 'Deleted user' }]);

    const nested = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'mention',
                  attrs: {
                    entityType: 'user',
                    entityId: 'u-1',
                    label: 'Иван Петров',
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const result = await service.refreshUserMentionLabels(nested, 'ws-1');

    expect(result.content[0].content[0].content[0].attrs.label).toBe(
      'Deleted user',
    );
  });
});
