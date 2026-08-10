import { describe, it, expect } from "vitest";
import { treeModel } from "./tree-model";
import type { TreeNode } from "./tree-model.types";

type N = TreeNode<{ name: string }>;

/**
 * Обход уровня строится на `Array.prototype.map`, а тот возвращает новый
 * массив всегда. Из-за этого сравнение `next !== n.children` было истинно у
 * каждого узла с детьми, и правка одного узла пересоздавала объекты всех
 * остальных ветвей. React видел новые идентичности и перерисовывал дерево
 * целиком.
 *
 * Прежний тест на идентичность этого не ловил: соседний узел в наборе был
 * листом, а лист возвращался как есть, минуя сломанную ветку.
 */
const fixture: N[] = [
  {
    id: "a",
    name: "A",
    children: [
      { id: "a1", name: "A1", children: [{ id: "a1a", name: "A1a" }] },
      { id: "a2", name: "A2" },
    ],
  },
  // Соседняя ветвь с детьми, ее объекты не должны пересоздаваться.
  {
    id: "b",
    name: "B",
    children: [
      { id: "b1", name: "B1", children: [{ id: "b1a", name: "B1a" }] },
    ],
  },
];

describe("ссылочная идентичность нетронутых ветвей", () => {
  it("update не пересоздает соседнюю ветвь с детьми", () => {
    const next = treeModel.update(fixture, "a1a", { name: "изменено" });

    expect(next[1]).toBe(fixture[1]);
    expect(next[1].children).toBe(fixture[1].children);
  });

  it("update не пересоздает нетронутых детей внутри тронутой ветви", () => {
    const next = treeModel.update(fixture, "a1a", { name: "изменено" });

    expect(treeModel.find(next, "a2")).toBe(treeModel.find(fixture, "a2"));
  });

  it("insert не пересоздает соседнюю ветвь", () => {
    const next = treeModel.insert(fixture, "a2", { id: "a2a", name: "A2a" });

    expect(next[1]).toBe(fixture[1]);
  });

  it("remove не пересоздает соседнюю ветвь", () => {
    const next = treeModel.remove(fixture, "a1a");

    expect(next[1]).toBe(fixture[1]);
  });

  it("appendChildren не пересоздает соседнюю ветвь", () => {
    const next = treeModel.appendChildren(fixture, "a2", [
      { id: "a2a", name: "A2a" },
    ]);

    expect(next[1]).toBe(fixture[1]);
  });

  /** Тронутая ветвь пересоздаваться обязана, иначе React не увидит правку. */
  it("тронутая ветвь пересоздается", () => {
    const next = treeModel.update(fixture, "a1a", { name: "изменено" });

    expect(next[0]).not.toBe(fixture[0]);
    expect(treeModel.find(next, "a1a")?.name).toBe("изменено");
  });
});
