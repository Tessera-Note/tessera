import "@/features/editor/styles/index.css";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import ReadonlyPageEditor from "@/features/editor/readonly-page-editor";
import { Container } from "@mantine/core";
import classes from "./pdf-render.module.css";

type PdfRenderPageData = {
  pageId: string;
  title: string;
  content: any;
};

export default function PdfRenderPage() {
  const { pageId } = useParams<{ pageId: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [pages, setPages] = useState<PdfRenderPageData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!pageId || !token) {
      setError("Missing page ID or token");
      return;
    }

    fetch("/api/pdf-export/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId, token }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      // The API wraps payloads in `data`; tolerate an extra layer so a stale
      // build of either side still renders instead of printing a blank page.
      .then((result) =>
        setPages(result.data?.pages ?? result.data?.data?.pages ?? []),
      )
      .catch((err) => setError(err.message));
  }, [pageId, token]);

  useEffect(() => {
    const title = pages?.[0]?.title;
    if (title) {
      document.title = title;
    }
  }, [pages]);

  /**
   * The exporter waits for the ready flag before printing, so the flag must mean
   * "the editors have painted", not "the data arrived". Tiptap mounts a frame or
   * more after render, and printing in between produces a near-empty PDF.
   */
  useEffect(() => {
    if (!pages || pages.length === 0) return;

    let cancelled = false;
    let attempts = 0;

    const poll = () => {
      if (cancelled) return;

      const painted = document.querySelectorAll(".ProseMirror").length;
      // 100 attempts ≈ 5s, well inside the render timeout. Giving up still
      // marks ready so a stubborn page prints as-is instead of timing out.
      if (painted >= pages.length || attempts > 100) {
        // A plain timer, not requestAnimationFrame: rAF is throttled to nothing
        // in a background tab, which would leave the flag unset forever.
        setTimeout(() => !cancelled && setReady(true), 100);
        return;
      }

      attempts += 1;
      setTimeout(poll, 50);
    };

    poll();

    return () => {
      cancelled = true;
    };
  }, [pages]);

  if (error) {
    // Flagged ready so the exporter fails with this message instead of hanging
    // until the render timeout.
    return <div data-pdf-ready="true">{error}</div>;
  }

  if (!pages) {
    return null;
  }

  if (pages.length === 0) {
    // Ready on purpose: a blank page would leave the exporter waiting until its
    // timeout, reporting nothing useful.
    return <div data-pdf-ready="true">Nothing to render</div>;
  }

  return (
    <Container
      size={900}
      p={0}
      className={classes.printRoot}
      data-pdf-ready={ready ? "true" : undefined}
    >
      {pages.map((page, index) => (
        <div
          key={page.pageId}
          // Every page after the first starts on a fresh sheet, so a subpage
          // never begins halfway down the previous one.
          className={index > 0 ? classes.pageBreak : undefined}
        >
          <ReadonlyPageEditor
            title={page.title}
            content={page.content}
            pageId={page.pageId}
            printMode
          />
        </div>
      ))}
    </Container>
  );
}
