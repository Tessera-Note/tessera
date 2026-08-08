import { describe, expect, it } from "vitest";
import { stripEditCommands } from "./strip-edit-commands";

describe("stripEditCommands", () => {
  it("keeps prose untouched", () => {
    expect(stripEditCommands("Olá, tudo bem?")).toBe("Olá, tudo bem?");
  });

  it("removes a completed edit command and its payload", () => {
    const text = [
      "Adicionei a seção ao final da página.",
      ":::EDIT_PAGE:::",
      '{"pageId":"abc","content":"# Deploy","operation":"append"}',
      ":::END_EDIT:::",
    ].join("\n");

    const result = stripEditCommands(text);

    expect(result).toBe("Adicionei a seção ao final da página.");
    expect(result).not.toContain("pageId");
  });

  it("removes a title command", () => {
    const text = [
      "Renomeei a página.",
      ":::UPDATE_TITLE:::",
      '{"pageId":"abc","title":"Runbook"}',
      ":::END_TITLE:::",
    ].join("\n");

    expect(stripEditCommands(text)).toBe("Renomeei a página.");
  });

  it("hides a command that is still streaming in", () => {
    const partial = [
      "Já vou atualizar:",
      ":::EDIT_PAGE:::",
      '{"pageId":"abc","content":"# Dep',
    ].join("\n");

    const result = stripEditCommands(partial);

    expect(result).toBe("Já vou atualizar:");
    expect(result).not.toContain("pageId");
  });

  it("removes several commands in one message", () => {
    const text = [
      "Feito.",
      ":::EDIT_PAGE:::",
      '{"pageId":"a","content":"x","operation":"append"}',
      ":::END_EDIT:::",
      "E também:",
      ":::UPDATE_TITLE:::",
      '{"pageId":"a","title":"y"}',
      ":::END_TITLE:::",
    ].join("\n");

    expect(stripEditCommands(text)).toBe("Feito.\n\nE também:");
  });

  // Known trade-off: an unterminated marker swallows the rest of the message,
  // which is what makes streaming clean. Prose that merely quotes the marker
  // loses its tail — acceptable, since the marker is an internal token users
  // have no reason to type.
  it("treats an unterminated marker as an open command", () => {
    const text = "Use `:::EDIT_PAGE:::` para editar.";
    expect(stripEditCommands(text)).toBe("Use `");
  });

  it("handles empty input", () => {
    expect(stripEditCommands(undefined)).toBe("");
    expect(stripEditCommands(null)).toBe("");
    expect(stripEditCommands("")).toBe("");
  });
});
