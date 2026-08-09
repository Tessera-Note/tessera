import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaError } from "./use-media-error";

/**
 * `audio` и `attachment` рисуются React-представлениями, и обработчика
 * ошибки у них не было вовсе: человек видел нерабочий плеер без объяснения,
 * а по кнопке загрузки открывался JSON с ошибкой сервера.
 */
describe("useMediaError", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("удаленный файл объясняется словами", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 404 })),
    );
    const { result } = renderHook(() => useMediaError());

    await act(async () => {
      await result.current.report("/api/files/x/y.mp3");
    });

    expect(result.current.message).toMatch(/no longer exists|deleted/i);
  });

  it("отказ по правам отличается от отсутствия файла", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 403 })),
    );
    const { result } = renderHook(() => useMediaError());

    await act(async () => {
      await result.current.report("/api/files/x/y.mp3");
    });

    expect(result.current.message).toMatch(/access/i);
  });

  it("статус возвращается вызывающему", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200 })),
    );
    const { result } = renderHook(() => useMediaError());

    let status: number | undefined;
    await act(async () => {
      status = await result.current.report("/api/files/x/y.mp3");
    });

    expect(status).toBe(200);
  });

  it("обрыв сети дает общее сообщение", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    const { result } = renderHook(() => useMediaError());

    await act(async () => {
      await result.current.report("/api/files/x/y.mp3");
    });

    expect(result.current.message).toBeTruthy();
  });

  it("пустой адрес не ходит в сеть", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useMediaError());

    await act(async () => {
      await result.current.report(null);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.message).toBeTruthy();
  });

  it("сообщение снимается", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 404 })),
    );
    const { result } = renderHook(() => useMediaError());

    await act(async () => {
      await result.current.report("/api/files/x/y.mp3");
    });
    act(() => result.current.clear());

    expect(result.current.message).toBeNull();
  });
});
