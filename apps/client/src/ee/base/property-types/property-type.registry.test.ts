import { describe, expect, it, vi } from "vitest";

// Реестр тянет за собой компоненты ячеек, а те через цепочку импортов —
// main.tsx, который монтирует приложение в #root. Узел нужен, чтобы импорт
// не падал, а монтирование заглушено: поднимать приложение целиком ради
// проверки таблицы дескрипторов не нужно, и его эффекты в jsdom падают.
vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
  createRoot: () => ({ render: () => {}, unmount: () => {} }),
}));

if (!document.getElementById("root")) {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
}

const { getDescriptor, PROPERTY_PICKER_ORDER } = await import(
  "./property-type.registry"
);

/**
 * Типы, которые может прислать сервер.
 *
 * Источник — `apps/server/src/ee/base/base.service.ts`: первичное свойство
 * создается с типом `title`, шаблон канбана добавляет `select`, остальные
 * приходят из пользовательских действий. Список продублирован здесь
 * намеренно: тест обязан ловить расхождение реестра с сервером, а не
 * повторять его же данные.
 */
const TYPES_FROM_SERVER = [
  "title",
  "text",
  "longText",
  "number",
  "select",
  "status",
  "multiSelect",
  "date",
  "person",
  "file",
  "formula",
  "page",
  "checkbox",
  "url",
  "email",
  "createdAt",
  "lastEditedAt",
  "lastEditedBy",
] as const;

describe("реестр типов свойств", () => {
  /**
   * Регресс: у типа `title` дескриптора не было, `GridCell` выходил через
   * `if (!CellComponent) return null`, ячейка первичного свойства не давала
   * узла, и все ячейки правее съезжали на колонку относительно заголовков.
   * Отсутствие дескриптора не выдает ошибки, поэтому ловится только так.
   */
  it.each(TYPES_FROM_SERVER)("у типа %s есть дескриптор", (type) => {
    expect(getDescriptor(type)).toBeDefined();
  });

  it.each(TYPES_FROM_SERVER)("у типа %s есть компонент ячейки", (type) => {
    expect(getDescriptor(type)?.cellComponent).toBeDefined();
  });

  it("у каждого типа из списка выбора есть дескриптор", () => {
    for (const type of PROPERTY_PICKER_ORDER) {
      expect(getDescriptor(type)).toBeDefined();
    }
  });

  // Пользователь не создает и не меняет тип на title: это тип первичного
  // свойства, его ставит только сервер.
  it("title не предлагается пользователю при выборе типа", () => {
    expect(PROPERTY_PICKER_ORDER).not.toContain("title");
  });

  it("неизвестный тип дескриптора не имеет", () => {
    expect(getDescriptor("выдуманный" as never)).toBeUndefined();
  });
});
