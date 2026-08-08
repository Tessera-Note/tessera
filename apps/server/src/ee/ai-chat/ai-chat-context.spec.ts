import { ForbiddenException } from '@nestjs/common';
import { AiChatService } from './ai-chat.service';

const user = { id: 'user-1' } as any;

const pageA = { id: 'page-a', title: 'A', content: {} } as any;
const pageB = { id: 'page-b', title: 'B', content: {} } as any;

describe('AiChatService.filterViewablePages', () => {
  function build(validateCanView: jest.Mock) {
    // Only pageAccessService is exercised here; the helper touches nothing else.
    const service = Object.create(AiChatService.prototype) as AiChatService;
    (service as any).pageAccessService = { validateCanView };
    return service;
  }

  it('drops pages the user cannot view', async () => {
    const validateCanView = jest.fn(async (page: any) => {
      if (page.id === 'page-b') throw new ForbiddenException();
    });
    const service = build(validateCanView);

    const result = await (service as any).filterViewablePages(
      [pageA, pageB],
      user,
    );

    expect(result.map((p: any) => p.id)).toEqual(['page-a']);
  });

  it('keeps every page the user can view', async () => {
    const service = build(jest.fn());

    const result = await (service as any).filterViewablePages(
      [pageA, pageB],
      user,
    );

    expect(result).toHaveLength(2);
  });

  it('returns an empty list when nothing is viewable', async () => {
    const service = build(
      jest.fn().mockRejectedValue(new ForbiddenException()),
    );

    const result = await (service as any).filterViewablePages(
      [pageA, pageB],
      user,
    );

    expect(result).toEqual([]);
  });
});
