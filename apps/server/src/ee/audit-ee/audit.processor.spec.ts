import { AuditProcessor } from './audit.processor';
import { QueueJob } from '../../integrations/queue/constants';

const JOB_DATA = {
  workspaceId: 'ws-1',
  actorId: 'user-1',
  actorType: 'user' as const,
  event: 'workspace.updated',
  resourceType: 'workspace',
  resourceId: 'ws-1',
  spaceId: null,
  changedFields: ['name'],
  metadata: { source: 'settings' },
  ipAddress: '203.0.113.7',
  createdAt: '2026-08-06T10:00:00.000Z',
};

function build() {
  const inserts: any[] = [];
  const db: any = {
    insertInto: () => ({
      values: (values: any) => {
        inserts.push(values);
        return { execute: async () => [] };
      },
    }),
  };
  const processor = new AuditProcessor(db);
  jest.spyOn((processor as any).logger, 'error').mockImplementation(() => {});
  return { processor, inserts };
}

const job = (data: any = JOB_DATA, name = QueueJob.AUDIT_LOG) =>
  ({ name, data }) as any;

describe('AuditProcessor', () => {
  it('пишет событие в таблицу audit', async () => {
    const { processor, inserts } = build();

    await processor.process(job());

    expect(inserts).toHaveLength(1);
    expect(inserts[0].event).toBe('workspace.updated');
    expect(inserts[0].workspaceId).toBe('ws-1');
    expect(inserts[0].actorId).toBe('user-1');
    expect(inserts[0].id).toEqual(expect.any(String));
  });

  it('время берется из задачи, а не из момента разбора', async () => {
    const { processor, inserts } = build();

    await processor.process(job());

    expect(inserts[0].createdAt).toEqual(new Date('2026-08-06T10:00:00.000Z'));
  });

  it('чужая задача из той же очереди игнорируется', async () => {
    const { processor, inserts } = build();

    await processor.process(job(JOB_DATA, QueueJob.AUDIT_CLEANUP));

    expect(inserts).toHaveLength(0);
  });

  it('отсутствие измененных полей дает null в changes', async () => {
    const { processor, inserts } = build();

    await processor.process(job({ ...JOB_DATA, changedFields: null }));

    expect(inserts[0].changes).toBeNull();
  });

  it('отсутствие метаданных дает null', async () => {
    const { processor, inserts } = build();

    await processor.process(job({ ...JOB_DATA, metadata: null }));

    expect(inserts[0].metadata).toBeNull();
  });

  // Колонка ip_address имеет тип inet и пустую строку не принимает.
  it('пустой адрес превращается в null', async () => {
    const { processor, inserts } = build();

    await processor.process(job({ ...JOB_DATA, ipAddress: '' }));

    expect(inserts[0].ipAddress).toBeNull();
  });

  // Регресс: без промежуточного ::text параметр доезжал до jsonb уже
  // закодированным, и в колонке оказывалась строка с JSON внутри вместо
  // объекта. На стенде jsonb_typeof давал 'string' и запросы по полям
  // ничего не находили.
  it('jsonb приводится через text, иначе получится строка вместо объекта', async () => {
    const { processor, inserts } = build();

    await processor.process(job());

    // toOperationNode отдает узел с готовыми кусками SQL, по ним и видно,
    // какое приведение попадет в запрос.
    const sqlOf = (value: any) =>
      value.toOperationNode().sqlFragments.join('?');

    expect(sqlOf(inserts[0].changes)).toContain('::text::jsonb');
    expect(sqlOf(inserts[0].metadata)).toContain('::text::jsonb');
  });

  it('сбой вставки пробрасывается, чтобы очередь повторила', async () => {
    const db: any = {
      insertInto: () => ({
        values: () => ({
          execute: async () => {
            throw new Error('база недоступна');
          },
        }),
      }),
    };
    const processor = new AuditProcessor(db);

    await expect(processor.process(job())).rejects.toThrow('база недоступна');
  });
});
