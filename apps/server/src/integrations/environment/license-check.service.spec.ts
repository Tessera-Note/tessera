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
   * Прежде здесь стояло «нереализованных возможностей не осталось». Это
   * фиксировало момент, а не правило: список успел стать непустым и снова
   * пустым.
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

  /**
   * Обратная сторона того же правила. Маршруты прав страницы появились,
   * поэтому возможность вернулась в доступные. Проверка держит связь между
   * объявлением и кодом: если маршруты когда-нибудь снимут, тест упадет здесь,
   * а не у человека в интерфейсе.
   */
  it('права страницы объявлены доступными вместе с маршрутами', () => {
    expect(service.resolveFeatures()).toContain(Feature.PAGE_PERMISSIONS);
    expect(service.listUnavailableFeatures()).not.toContain(
      Feature.PAGE_PERMISSIONS,
    );
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
