import { describe, expect, it } from "vitest";
import { buildColumnVisibility } from "./column-visibility";
import type { IBaseProperty } from "@/ee/base/types/base.types";

const property = (id: string, isPrimary = false): IBaseProperty =>
  ({
    id,
    name: id,
    type: isPrimary ? "title" : "text",
    isPrimary,
  }) as IBaseProperty;

const PROPERTIES = [
  property("title", true),
  property("text-1"),
  property("status"),
];

/**
 * Шапка рисует колонку первичного свойства всегда: у нее enableHiding: false.
 * Если состояние видимости говорит обратное, тело строки ячейку не рендерит,
 * и все последующие ячейки съезжают на колонку влево. Число ячеек в теле
 * обязано совпадать с числом заголовков при любом состоянии видимости.
 */
function visibleCount(visibility: Record<string, boolean>): number {
  return Object.entries(visibility).filter(([, visible]) => visible).length;
}

describe("buildColumnVisibility", () => {
  it("без конфигурации показывает все колонки", () => {
    const visibility = buildColumnVisibility(undefined, PROPERTIES);

    expect(visibility).toEqual({
      __row_number: true,
      title: true,
      "text-1": true,
      status: true,
    });
  });

  it("скрывает обычные свойства из hiddenPropertyIds", () => {
    const visibility = buildColumnVisibility(
      { hiddenPropertyIds: ["text-1"] },
      PROPERTIES,
    );

    expect(visibility["text-1"]).toBe(false);
    expect(visibility.status).toBe(true);
  });

  // Регресс: конфигурация с первичным свойством в скрытых разводила шапку
  // и тело, ячейка «Статус» вставала под заголовок предыдущей колонки.
  it("не скрывает первичное свойство через hiddenPropertyIds", () => {
    const visibility = buildColumnVisibility(
      { hiddenPropertyIds: ["title", "text-1"] },
      PROPERTIES,
    );

    expect(visibility.title).toBe(true);
    expect(visibility["text-1"]).toBe(false);
  });

  it("не скрывает первичное свойство через visiblePropertyIds", () => {
    const visibility = buildColumnVisibility(
      { visiblePropertyIds: ["status"] },
      PROPERTIES,
    );

    expect(visibility.title).toBe(true);
    expect(visibility.status).toBe(true);
    expect(visibility["text-1"]).toBe(false);
  });

  it("служебная колонка номера строки всегда видима", () => {
    for (const config of [
      undefined,
      { hiddenPropertyIds: ["title", "text-1", "status"] },
      { visiblePropertyIds: [] },
    ]) {
      expect(buildColumnVisibility(config, PROPERTIES).__row_number).toBe(true);
    }
  });

  // Шапка рисует служебную колонку, первичное свойство и все видимые.
  // Тело обязано отдать столько же ячеек.
  it("число видимых колонок не расходится с числом заголовков", () => {
    const cases = [
      { config: undefined, ожидается: 4 },
      { config: { hiddenPropertyIds: ["text-1"] }, ожидается: 3 },
      { config: { hiddenPropertyIds: ["title"] }, ожидается: 4 },
      { config: { visiblePropertyIds: ["status"] }, ожидается: 3 },
      { config: { visiblePropertyIds: ["title"] }, ожидается: 2 },
    ];

    for (const { config, ожидается } of cases) {
      const visibility = buildColumnVisibility(config, PROPERTIES);
      // Заголовков столько же: скрытые колонки шапка тоже не рисует, кроме
      // первичной, которая в visibility всегда true.
      expect(visibleCount(visibility)).toBe(ожидается);
    }
  });
});
