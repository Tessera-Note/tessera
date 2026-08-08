import { describe, expect, it } from "vitest";
import { isChatAccessError } from "./chat-access-error";

/**
 * Из чата выбрасывало на любую ошибку. Отказ по частоте запросов возвращает
 * 429, и человек терял открытый разговор из-за временного ограничения.
 */
describe("isChatAccessError", () => {
  it.each([403, 404])("отказ по доступу %s уводит с адреса", (status) => {
    expect(isChatAccessError({ response: { status } })).toBe(true);
  });

  it.each([429, 500, 502, 503])(
    "временный отказ %s с адреса не уводит",
    (status) => {
      expect(isChatAccessError({ response: { status } })).toBe(false);
    },
  );

  it("обрыв сети без ответа с адреса не уводит", () => {
    expect(isChatAccessError(new Error("Network Error"))).toBe(false);
  });

  it("отсутствие ошибки не считается отказом", () => {
    expect(isChatAccessError(undefined)).toBe(false);
    expect(isChatAccessError(null)).toBe(false);
  });
});
