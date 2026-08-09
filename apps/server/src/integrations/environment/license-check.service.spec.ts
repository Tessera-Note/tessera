import { LicenseCheckService } from './license-check.service';
import { Feature } from '../../common/features';

describe('LicenseCheckService', () => {
  const service = new LicenseCheckService();

  it('фиксирует уровень экземпляра', () => {
    expect(service.resolveTier()).toBe('enterprise');
  });

  it('отдает возможности, за которыми стоит рабочий код', () => {
    const features = service.resolveFeatures();

    expect(features).toContain(Feature.BASES);
    expect(features).toContain(Feature.AI);
    expect(features).toContain(Feature.SCIM);
  });

  /**
   * Список пуст: за каждой объявленной возможностью стоит реализация.
   * Проверка сторожит инвариант, а не конкретный ключ: как только в список
   * попадет новая незакрытая возможность, тест ниже потребует, чтобы она
   * действительно запрещалась.
   */
  /**
   * Прежде здесь стояло «нереализованных возможностей не осталось». Это было
   * верно на момент закрытия блока и перестало быть верным: у прав страницы
   * клиент зовет семь маршрутов, а сервер отвечает 404 на каждый.
   *
   * Проверяется не пустота списка, а само правило: возможность объявлена
   * доступной тогда и только тогда, когда за ней стоит рабочий код, и один
   * ключ не может быть в обоих списках сразу.
   */
  it('списки доступных и недоступных не пересекаются', () => {
    const available = service.resolveFeatures();
    const unavailable = service.listUnavailableFeatures();

    expect(
      available.filter((feature) => unavailable.includes(feature)),
    ).toEqual([]);
  });

  it('права страницы объявлены недоступными, пока нет маршрутов', () => {
    expect(service.listUnavailableFeatures()).toContain(
      Feature.PAGE_PERMISSIONS,
    );
    expect(service.resolveFeatures()).not.toContain(Feature.PAGE_PERMISSIONS);
  });

  it('возвращает копию списка, а не сам список', () => {
    const first = service.resolveFeatures();
    first.push('поддельная возможность' as any);

    expect(service.resolveFeatures()).not.toContain(
      'поддельная возможность' as any,
    );
  });

  it('разрешает реализованную возможность', () => {
    expect(service.hasFeature(Feature.BASES)).toBe(true);
  });

  it('запрещает любую возможность из списка недоступных', () => {
    for (const feature of service.listUnavailableFeatures()) {
      expect(service.hasFeature(feature)).toBe(false);
    }
  });

  it('принимает строковый литерал наравне с ключом перечисления', () => {
    expect(service.hasFeature('bases')).toBe(true);
    expect(service.hasFeature('неизвестная возможность')).toBe(false);
  });

  it('не пересекает доступные и недоступные возможности', () => {
    const available = new Set<string>(service.resolveFeatures());
    const unavailable = service.listUnavailableFeatures();

    for (const feature of unavailable) {
      expect(available.has(feature)).toBe(false);
    }
  });

  it('классифицирует каждую объявленную возможность', () => {
    const classified = new Set<string>([
      ...service.resolveFeatures(),
      ...service.listUnavailableFeatures(),
    ]);

    for (const feature of Object.values(Feature)) {
      expect(classified.has(feature)).toBe(true);
    }
  });
});
