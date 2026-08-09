import {
  DIRECT_NOTIFICATION_TYPES,
  NotificationType,
  NotificationTypeToSettingKey,
  UPDATES_NOTIFICATION_TYPES,
} from './notification.constants';
import { NotificationService } from './notification.service';

/**
 * Шесть видов уведомлений начали создаваться и рассылаться письмами, но
 * выключателя у них не было: `queueEmail` без типа настройку не спрашивает, и
 * отказаться от таких писем было нельзя.
 *
 * Проверяется правило, а не текущий список: у каждого вида, который доходит до
 * человека, есть выключатель, и выключатель этот соблюдается.
 */
function build(settings: any) {
  const chain: any = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () => ({
      email: 'u@example.com',
      settings,
      locale: 'ru-RU',
    }),
  };

  const mailService: any = { sendToQueue: jest.fn(async () => {}) };
  const service: NotificationService = Object.create(
    NotificationService.prototype,
  );
  (service as any).db = { selectFrom: () => chain };
  (service as any).mailService = mailService;
  (service as any).logger = { error: jest.fn() };

  return { service, mailService };
}

describe('Настройки уведомлений', () => {
  /**
   * Вид без выключателя письмом не управляется вовсе. Именно так и вышло с
   * верификацией: обработчики появились, а настройка нет.
   */
  it('у каждого доходящего до человека вида есть выключатель', () => {
    const reaching = [
      ...DIRECT_NOTIFICATION_TYPES,
      ...UPDATES_NOTIFICATION_TYPES,
    ];

    expect(
      reaching.filter((type) => !NotificationTypeToSettingKey[type]),
    ).toEqual([]);
  });

  it('каждый объявленный вид отнесен к вкладке', () => {
    const assigned = new Set<string>([
      ...DIRECT_NOTIFICATION_TYPES,
      ...UPDATES_NOTIFICATION_TYPES,
    ]);

    expect(
      Object.values(NotificationType).filter((type) => !assigned.has(type)),
    ).toEqual([]);
  });

  it('выключенная настройка отменяет письмо', async () => {
    const { service, mailService } = build({
      notifications: { 'page.approvalRequested': false },
    });

    await service.queueEmail(
      'u-1',
      'n-1',
      () => ({ subject: 'тема', template: null }),
      NotificationType.PAGE_APPROVAL_REQUESTED,
    );

    expect(mailService.sendToQueue).not.toHaveBeenCalled();
  });

  /** Умолчание это «уведомлять»: настройки у человека может не быть вовсе. */
  it('отсутствие настройки письмо не отменяет', async () => {
    const { service, mailService } = build({});

    await service.queueEmail(
      'u-1',
      'n-1',
      () => ({ subject: 'тема', template: null }),
      NotificationType.PAGE_APPROVAL_REQUESTED,
    );

    expect(mailService.sendToQueue).toHaveBeenCalled();
  });

  /**
   * Четыре вида про проверку страницы делят один выключатель: человек
   * различает поводы, а не виды, и исходы проверки для него один повод.
   */
  it.each([
    NotificationType.PAGE_VERIFIED,
    NotificationType.PAGE_APPROVAL_REJECTED,
    NotificationType.PAGE_VERIFICATION_EXPIRING,
    NotificationType.PAGE_VERIFICATION_EXPIRED,
  ])('%s отменяется общим выключателем проверки', async (type) => {
    const { service, mailService } = build({
      notifications: { 'page.verificationUpdates': false },
    });

    await service.queueEmail(
      'u-1',
      'n-1',
      () => ({ subject: 'тема', template: null }),
      type,
    );

    expect(mailService.sendToQueue).not.toHaveBeenCalled();
  });

  /**
   * Тема и шаблон собираются внутри постановки, а не у вызывающего: язык
   * известен только после чтения записи получателя, а один вызывающий
   * рассылает письмо нескольким людям с разными языками.
   */
  it('письмо собирается на языке получателя', async () => {
    const { service, mailService } = build({});
    const seen: string[] = [];

    await service.queueEmail('u-1', 'n-1', (locale) => {
      seen.push(locale);
      return { subject: `тема ${locale}`, template: null };
    });

    expect(seen).toEqual(['ru-RU']);
    expect(mailService.sendToQueue).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'тема ru-RU' }),
    );
  });

  /** Просьба об утверждении требует действия, поэтому мутится отдельно. */
  it('общий выключатель проверки не глушит просьбу об утверждении', async () => {
    const { service, mailService } = build({
      notifications: { 'page.verificationUpdates': false },
    });

    await service.queueEmail(
      'u-1',
      'n-1',
      () => ({ subject: 'тема', template: null }),
      NotificationType.PAGE_APPROVAL_REQUESTED,
    );

    expect(mailService.sendToQueue).toHaveBeenCalled();
  });
});
