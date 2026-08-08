import type { VisibilityState } from "@tanstack/react-table";
import type { IBaseProperty, ViewConfig } from "@/ee/base/types/base.types";

/**
 * Видимость колонок по конфигурации представления.
 *
 * Первичное свойство скрыть нельзя: у его колонки `enableHiding: false`,
 * поэтому шапка рисует ее в любом случае. Если при этом в состоянии видимости
 * стоит `false`, тело строки ячейку не рендерит, и все последующие ячейки
 * съезжают на колонку влево относительно заголовков. Именно так конфигурация
 * с первичным свойством в hiddenPropertyIds ломала выравнивание таблицы.
 *
 * Поэтому ключ первичного свойства не принимает `false` ни на одном пути.
 */
export function buildColumnVisibility(
  config: ViewConfig | undefined,
  properties: IBaseProperty[],
): VisibilityState {
  const visibility: VisibilityState = { __row_number: true };

  const apply = (property: IBaseProperty, visible: boolean) => {
    visibility[property.id] = property.isPrimary ? true : visible;
  };

  if (config?.hiddenPropertyIds) {
    const hiddenSet = new Set(config.hiddenPropertyIds);
    properties.forEach((p) => apply(p, !hiddenSet.has(p.id)));
    return visibility;
  }

  if (config?.visiblePropertyIds?.length) {
    const visibleSet = new Set(config.visiblePropertyIds);
    properties.forEach((p) => apply(p, visibleSet.has(p.id)));
    return visibility;
  }

  properties.forEach((p) => apply(p, true));
  return visibility;
}
