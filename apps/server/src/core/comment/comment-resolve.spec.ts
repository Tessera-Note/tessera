import { CommentService } from './comment.service';

/**
 * Разрешение обсуждения. Клиент вызывал `/comments/resolve` с самого начала,
 * но маршрута и записи в `resolved_at` не было.
 */
function build() {
  const updated = { id: 'c1', resolvedAt: new Date(), resolvedById: 'user-1' };
  const commentRepo: any = {
    updateComment: jest.fn(),
    findById: jest.fn().mockResolvedValue(updated),
  };
  const service = new CommentService(
    commentRepo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, commentRepo };
}

describe('CommentService.resolve', () => {
  const comment = { id: 'c1', pageId: 'p1' } as any;
  const user = { id: 'user-1' } as any;

  it('отмечает обсуждение решенным и запоминает, кто решил', async () => {
    const { service, commentRepo } = build();

    await service.resolve(comment, true, user);

    const [values, id] = commentRepo.updateComment.mock.calls[0];
    expect(id).toBe('c1');
    expect(values.resolvedById).toBe('user-1');
    expect(values.resolvedAt).toBeInstanceOf(Date);
  });

  it('снимает отметку и очищает автора решения', async () => {
    const { service, commentRepo } = build();

    await service.resolve(comment, false, user);

    const [values] = commentRepo.updateComment.mock.calls[0];
    expect(values.resolvedAt).toBeNull();
    expect(values.resolvedById).toBeNull();
  });

  it('возвращает комментарий с автором решения', async () => {
    const { service, commentRepo } = build();

    await service.resolve(comment, true, user);

    expect(commentRepo.findById).toHaveBeenCalledWith('c1', {
      includeCreator: true,
      includeResolvedBy: true,
    });
  });
});
