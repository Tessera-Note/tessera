import { Injectable } from '@nestjs/common';
import { Feature, FeatureKey } from '../../common/features';

export type LicenseTier = 'free' | 'standard' | 'business' | 'enterprise';

/**
 * Решает, какие возможности доступны экземпляру.
 *
 * Экземпляр обслуживается внутри организации и не обращается к внешнему
 * поставщику лицензий: проверять ключ негде и не у кого. Поэтому уровень
 * фиксирован, а состав возможностей определяется тем, что реально реализовано
 * в этой сборке.
 *
 * Список ниже — не политика продаж, а карта готовности. Возможность включена
 * тогда и только тогда, когда за ней стоит рабочий код. Иначе интерфейс
 * предлагал бы пользователю то, чего нет: например, включить SCIM, за которым
 * нет ни одного маршрута.
 *
 * При реализации модуля из `docs/future-roadmap.md` его ключ переносится из
 * UNAVAILABLE_FEATURES в AVAILABLE_FEATURES, и это единственная правка,
 * которая для этого нужна.
 */

/** Возможности, за которыми стоит рабочий код. */
const AVAILABLE_FEATURES: readonly FeatureKey[] = [
  Feature.AI,
  Feature.MCP,
  Feature.TEMPLATES,
  Feature.BASES,
  Feature.PDF_EXPORT,
  Feature.API_KEYS,
  Feature.PAGE_PERMISSIONS,
  Feature.PERSONAL_SPACES,
  Feature.SHARING_CONTROLS,
  Feature.SECURITY_SETTINGS,
  Feature.VIEWER_COMMENTS,
  Feature.COMMENT_RESOLUTION,
  Feature.PAGE_VERIFICATION,
  Feature.ATTACHMENT_INDEXING,
  Feature.AUDIT_LOGS,
  Feature.DOCX_EXPORT,
  Feature.RETENTION, // срок хранения корзины, не журнала
  Feature.DOCX_IMPORT,
  Feature.PDF_IMPORT,
  Feature.CONFLUENCE_IMPORT,
  Feature.MFA,
  Feature.SSO_CUSTOM,
  Feature.SSO_GOOGLE,
  Feature.SCIM,
];

/**
 * Возможности, у которых есть схема базы, интерфейс или точка загрузки, но нет
 * реализации. Каждая строка соответствует пункту docs/future-roadmap.md.
 */
const UNAVAILABLE_FEATURES: readonly FeatureKey[] = [];

@Injectable()
export class LicenseCheckService {
  /**
   * Уровень экземпляра. Разграничения по уровням в этом развертывании нет.
   */
  resolveTier(): LicenseTier {
    return 'enterprise';
  }

  /** Возможности, доступные экземпляру. */
  resolveFeatures(): FeatureKey[] {
    return [...AVAILABLE_FEATURES];
  }

  /**
   * Доступна ли конкретная возможность.
   *
   * Принимает и ключ из перечисления Feature, и произвольную строку: часть
   * вызывающего кода передает строковый литерал напрямую.
   */
  hasFeature(feature: FeatureKey | string): boolean {
    return (AVAILABLE_FEATURES as readonly string[]).includes(feature);
  }

  /** Возможности, объявленные в коде, но пока не реализованные. */
  listUnavailableFeatures(): FeatureKey[] {
    return [...UNAVAILABLE_FEATURES];
  }
}
