import { PageListener } from './page.listener';
import { QueueJob } from '../../integrations/queue/constants';

/**
 * Очередь поиска убрана вместе с объявлениями Typesense: модуля
 * `ee/typesense` в проекте нет, сабмодули запрещены, а обработчика у очереди
 * не было ни одного. Установка с таким драйвером получала неработающий поиск
 * и бесконечно растущую очередь: на стенде накопилось 139 задач.
 *
 * Проверяется, что события страницы идут только в очередь ИИ.
 */
function build() {
  const aiQueue: any = { add: jest.fn(async () => {}) };
  const listener = new PageListener(aiQueue);

  return { listener, aiQueue };
}

const event = { pageIds: ['p-1'], workspaceId: 'ws-1' } as any;

describe('PageListener, очереди', () => {
  it('обновление страницы идет только в очередь ИИ', async () => {
    const { listener, aiQueue } = build();

    await listener.handlePageUpdated(event);

    expect(aiQueue.add).toHaveBeenCalledTimes(1);
    expect(aiQueue.add).toHaveBeenCalledWith(QueueJob.PAGE_UPDATED, {
      pageIds: ['p-1'],
      workspaceId: 'ws-1',
    });
  });

  it('создание страницы идет только в очередь ИИ', async () => {
    const { listener, aiQueue } = build();

    await listener.handlePageCreated(event);

    expect(aiQueue.add).toHaveBeenCalledTimes(1);
  });

  it('удаление страницы идет только в очередь ИИ', async () => {
    const { listener, aiQueue } = build();

    await listener.handlePageDeleted(event);

    expect(aiQueue.add).toHaveBeenCalledTimes(1);
  });
});
