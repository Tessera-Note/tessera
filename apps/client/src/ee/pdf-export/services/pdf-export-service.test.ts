import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
const saveAs = vi.fn();

vi.mock("@/lib/api-client.ts", () => ({ default: { post } }));
vi.mock("file-saver", () => ({ saveAs }));
vi.mock("@/features/file-task/services/file-task-service.ts", () => ({
  getFileTaskById: vi.fn(),
}));

const { downloadPagePdf } = await import("./pdf-export-service");

describe("downloadPagePdf", () => {
  beforeEach(() => {
    post.mockReset();
    saveAs.mockReset();
  });

  it("names the file from the content-disposition header", async () => {
    const blob = new Blob(["%PDF"], { type: "application/pdf" });
    post.mockResolvedValue({
      data: blob,
      headers: {
        "content-disposition":
          'attachment; filename="Runbook%20de%20Deploy.pdf"',
      },
    });

    await downloadPagePdf("task-1");

    expect(saveAs).toHaveBeenCalledWith(blob, "Runbook de Deploy.pdf");
  });

  /**
   * The api-client interceptor returns only the body for endpoints outside its
   * exempt list. Reading `headers` off that unwrapped response is what produced
   * "Cannot read properties of undefined (reading 'content-disposition')" in
   * production, so this shape has to keep working.
   */
  it("still downloads when the response has been unwrapped to a blob", async () => {
    const blob = new Blob(["%PDF"], { type: "application/pdf" });
    post.mockResolvedValue(blob);

    await downloadPagePdf("task-1", "Fluxo de envio.pdf");

    expect(saveAs).toHaveBeenCalledWith(blob, "Fluxo de envio.pdf");
  });

  it("falls back to the task name when the header is missing", async () => {
    const blob = new Blob(["%PDF"], { type: "application/pdf" });
    post.mockResolvedValue({ data: blob, headers: {} });

    await downloadPagePdf("task-1", "Politica de ferias.pdf");

    expect(saveAs).toHaveBeenCalledWith(blob, "Politica de ferias.pdf");
  });

  it("uses a generic name when nothing else is available", async () => {
    const blob = new Blob(["%PDF"], { type: "application/pdf" });
    post.mockResolvedValue({ data: blob, headers: {} });

    await downloadPagePdf("task-1");

    expect(saveAs).toHaveBeenCalledWith(blob, "page.pdf");
  });
});
