import { ExportService } from './export.service';

/**
 * Упоминание страницы превращается в выгрузке в ссылку. Если цель не
 * разрешилась, прежде собирался адрес со slug пространства `undefined`, то
 * есть заведомо битая ссылка. Цель не разрешается в двух случаях: страница
 * удалена или недоступна тому, кто выгружает, и тогда она отфильтрована
 * проверкой прав выше по коду.
 */
function build(pages: any[], accessible?: string[]) {
  const service: ExportService = Object.create(ExportService.prototype);

  const chain: any = {
    innerJoin: () => chain,
    select: () => chain,
    selectAll: () => chain,
    where: () => chain,
    execute: async () => pages,
  };
  (service as any).db = { selectFrom: () => chain };
  (service as any).pagePermissionRepo = {
    filterAccessiblePageIds: jest.fn(async () => accessible ?? []),
  };

  return service;
}

const doc = () => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'См. ' },
        {
          type: 'mention',
          attrs: {
            entityType: 'page',
            entityId: 'p-1',
            slugId: 'abc123',
            label: 'Регламент',
          },
        },
      ],
    },
  ],
});

function textOf(json: any): string {
  const out: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (typeof node.text === 'string') out.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(json);
  return out.join('');
}

function linksOf(json: any): string[] {
  const out: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link' && mark.attrs?.href) out.push(mark.attrs.href);
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(json);
  return out;
}

describe('ExportService.turnPageMentionsToLinks', () => {
  it('разрешенная цель становится ссылкой', async () => {
    const service = build([
      {
        id: 'p-1',
        title: 'Регламент',
        slugId: 'abc123',
        space: { slug: 'ops' },
      },
    ]);

    const result = await service.turnPageMentionsToLinks(
      doc(),
      'ws-1',
      'https://wiki.example.com',
      undefined,
      true,
    );

    expect(linksOf(result)).toEqual([
      'https://wiki.example.com/s/ops/p/reglament-abc123',
    ]);
  });

  it('неразрешенная цель разворачивается в текст, а не в битую ссылку', async () => {
    const service = build([]);

    const result = await service.turnPageMentionsToLinks(
      doc(),
      'ws-1',
      'https://wiki.example.com',
      undefined,
      true,
    );

    expect(linksOf(result)).toEqual([]);
    expect(textOf(result)).toContain('Регламент');
  });

  /** Именно этот адрес и получался прежде. */
  it('slug пространства undefined в выгрузке не появляется', async () => {
    const service = build([]);

    const result = await service.turnPageMentionsToLinks(
      doc(),
      'ws-1',
      'https://wiki.example.com',
      undefined,
      true,
    );

    expect(JSON.stringify(result)).not.toContain('/s/undefined/');
  });

  it('без упоминаний страниц документ возвращается как есть', async () => {
    const service = build([]);
    const plain = { type: 'doc', content: [{ type: 'paragraph' }] };

    await expect(
      service.turnPageMentionsToLinks(
        plain,
        'ws-1',
        'https://wiki.example.com',
      ),
    ).resolves.toBe(plain);
  });
});
