import { PageListener } from './page.listener';
import { QueueJob } from '../../integrations/queue/constants';

/**
 * Очередь поиска обслуживается только при `SEARCH_DRIVER=typesense`, и
 * обработчика у нее в этой сборке нет вовсе. Проверка драйвера стояла у
 * четырех постановок из пяти: сохранение страницы откладывало задачу навсегда.
 *
 * Замерено на стенде до правки: 139 задач `page-updated` ждали
 * несуществующего обработчика, а Redis работает с `maxmemory-policy
 * noeviction`, где переполнение начинает отказывать в записи.
 */
function build(searchDriver: string) {
  const searchQueue: any = { add: jest.fn(async () => {}) };
  const aiQueue: any = { add: jest.fn(async () => {}) };
  const environmentService: any = { getSearchDriver: () => searchDriver };

  const listener = new PageListener(environmentService, searchQueue, aiQueue);

  return { listener, searchQueue, aiQueue };
}

describe('PageListener, очередь поиска', () => {
  const event = { pageIds: ['p-1'], workspaceId: 'ws-1' } as any;

  it('без typesense обновление страницы в очередь поиска не идет', async () => {
    const { listener, searchQueue } = build('database');

    await listener.handlePageUpdated(event);

    expect(searchQueue.add).not.toHaveBeenCalled();
  });

  it('с typesense обновление в очередь поиска идет', async () => {
    const { listener, searchQueue } = build('typesense');

    await listener.handlePageUpdated(event);

    expect(searchQueue.add).toHaveBeenCalledWith(QueueJob.PAGE_UPDATED, {
      pageIds: ['p-1'],
    });
  });

  // Очередь ИИ обслуживается всегда и от драйвера поиска не зависит.
  it('очередь ИИ ставится независимо от драйвера поиска', async () => {
    const { listener, aiQueue } = build('database');

    await listener.handlePageUpdated(event);

    expect(aiQueue.add).toHaveBeenCalledWith(QueueJob.PAGE_UPDATED, {
      pageIds: ['p-1'],
      workspaceId: 'ws-1',
    });
  });
});
