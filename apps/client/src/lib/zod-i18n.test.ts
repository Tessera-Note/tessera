import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("@/i18n", () => ({
  default: {
    t: (key: string, opts?: { defaultValue?: string }) =>
      key === "Password is required"
        ? "Укажите пароль"
        : (opts?.defaultValue ?? key),
  },
}));

const { i18nZodResolver } = await import("./zod-i18n");

/**
 * Схемы zod объявляются на уровне модуля, где хук перевода вызвать нельзя,
 * поэтому сообщения под полями формы оставались английскими на всех локалях.
 * Переводится результат резолвера, а не схема.
 */
const schema = z.object({
  password: z.string().min(1, { message: "Password is required" }),
  nickname: z.string().min(3, { message: "Nickname is too short" }),
});

describe("i18nZodResolver", () => {
  it("заведенное сообщение приходит переведенным", () => {
    const errors = i18nZodResolver(schema)({ password: "", nickname: "абв" });

    expect(errors.password).toBe("Укажите пароль");
  });

  /** Незаведенное сообщение возвращается как есть, а не пустой строкой. */
  it("незаведенное сообщение остается прежним", () => {
    const errors = i18nZodResolver(schema)({ password: "x", nickname: "аб" });

    expect(errors.nickname).toBe("Nickname is too short");
  });

  it("на исправных значениях ошибок нет", () => {
    const errors = i18nZodResolver(schema)({
      password: "x",
      nickname: "абвг",
    });

    expect(errors).toEqual({});
  });
});
