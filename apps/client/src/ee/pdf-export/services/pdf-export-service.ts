import { saveAs } from "file-saver";
import api from "@/lib/api-client.ts";
import { getFileTaskById } from "@/features/file-task/services/file-task-service.ts";

/** How long to wait for the headless render before giving up on the poll. */
const POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;

export async function requestPagePdf(data: {
  pageId: string;
  includeChildren?: boolean;
}): Promise<{ fileTaskId: string }> {
  const req = await api.post<{ fileTaskId: string }>("/pdf-export/page", data);
  return req.data;
}

export async function downloadPagePdf(
  fileTaskId: string,
  fallbackName = "page.pdf",
): Promise<void> {
  const req = await api.post(
    "/pdf-export/download",
    { fileTaskId },
    { responseType: "blob" },
  );

  // This endpoint is on the api-client's exempt list, so the full response is
  // returned rather than just its body. Optional chaining anyway: if it ever
  // drops off that list, the download should still work with the task's name
  // instead of throwing on a missing header.
  const header = req?.headers?.["content-disposition"] ?? "";
  const rawName = header.split("filename=")[1]?.replace(/"/g, "");

  let fileName = rawName || fallbackName;
  if (rawName) {
    try {
      fileName = decodeURIComponent(rawName);
    } catch {
      // fallback to raw filename
    }
  }

  const blob = req?.data ?? req;
  saveAs(blob, fileName);
}

/**
 * Rendering happens in a background worker, so the client asks for the export
 * and then polls the shared file-task record until it succeeds or fails.
 */
export async function exportPageToPdf(data: {
  pageId: string;
  includeChildren?: boolean;
}): Promise<void> {
  const { fileTaskId } = await requestPagePdf(data);

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const task = await getFileTaskById(fileTaskId);

    if (task.status === "success") {
      await downloadPagePdf(fileTaskId, task.fileName);
      return;
    }

    if (task.status === "failed") {
      throw new Error(task.errorMessage || "PDF generation failed");
    }
  }

  throw new Error(
    "The PDF is taking longer than expected. It will appear in your exports once it finishes.",
  );
}
