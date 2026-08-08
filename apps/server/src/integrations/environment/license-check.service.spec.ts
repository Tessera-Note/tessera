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
  it('нереализованных возможностей не осталось', () => {
    expect(service.listUnavailableFeatures()).toEqual([]);
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
