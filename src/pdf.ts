// Legacy build: the modern build needs very recent browsers (Uint8Array.toHex etc.), too new for older site iPads.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFPageProxy, RenderTask } from "pdfjs-dist/types/src/display/api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export const OPS = pdfjs.OPS;

export type { PDFDocumentLoadingTask, PDFPageProxy };

/** Returns the loading task: await `.promise` for the document, call `.destroy()` to free worker memory. */
export function loadPdf(data: Uint8Array): PDFDocumentLoadingTask {
  return pdfjs.getDocument({ data });
}

// pdf.js renders in ~15 ms chunks and by default waits for requestAnimationFrame between them. rAF is throttled
// (2 fps in unfocused/embedded frames, paused in hidden tabs), which turned a 0.5 s render into 10 s+.
// Yield via MessageChannel instead: lets input events through between chunks without waiting for a frame.
const channel = new MessageChannel();
const queue: (() => void)[] = [];
channel.port1.onmessage = () => queue.shift()?.();
const yieldThen = (fn: () => void) => { queue.push(fn); channel.port2.postMessage(0); };

/**
 * Render view-space rect (x, y, w, h) of `page` at `scale` device px per pt into `canvas`. Resolves false if cancelled.
 * `rotation`: degrees clockwise, absolute like pdf.js (default: the page's own).
 */
export function renderRegion(
  page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number,
  x: number, y: number, w: number, h: number, rotation = page.rotate,
): { task: RenderTask; done: Promise<boolean> } {
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  const task = page.render({
    canvas,
    viewport: page.getViewport({ scale, rotation }),
    transform: [1, 0, 0, 1, -x * scale, -y * scale],
  });
  // Private field (pdfjs-dist pinned in package.json). If a pdf.js upgrade renames it, rendering still works, just
  // rAF-paced again. onContinue alone isn't enough: pdf.js hands it a callback that itself waits for rAF.
  const internal = (task as unknown as { _internalRenderTask?: { _useRequestAnimationFrame?: boolean } })._internalRenderTask;
  if (internal?._useRequestAnimationFrame) {
    internal._useRequestAnimationFrame = false;
    task.onContinue = yieldThen;
  }
  const done = task.promise.then(() => true, (e) => {
    if (e?.name === "RenderingCancelledException") return false;
    throw e;
  });
  return { task, done };
}
