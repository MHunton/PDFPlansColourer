// Automatic room detection: room labels (text layer, or read from glyph shapes) give seeds; barrier rasters come
// from the page's vector paths (detect.ts); a worker flood-fills from each seed and traces outlines (segment.ts).
// Returns polygons in PDF space.
import { apply, invert, type Mat, type Pt } from "./coords";
import type { PDFPageProxy } from "./pdf";
import { prepare } from "./detect";
import type { RoomLabel, TextItem } from "./roomLabels";
import type { Room, SegmentInput } from "./segment";

export interface DetectedRoom { no: string; name: string; points: Pt[] }
/** `labels`: every room label found in the text, traced or not. */
export interface Detection { rooms: DetectedRoom[]; labels: RoomLabel[]; scale: number | null }

export async function detectRooms(page: PDFPageProxy, progress: (pct: number) => void = () => {}): Promise<Detection> {
  const items = (await page.getTextContent()).items.filter((i) => "str" in i) as TextItem[];
  const vp = page.getViewport({ scale: 1 });
  const m = vp.transform as Mat;
  const canvas = (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: w, height: h });
  const { input, labels, scale, s } = await prepare(
    { ops: await page.getOperatorList(), items, view: { width: vp.width, height: vp.height, transform: m } },
    canvas, (pct) => progress(pct * 0.8),
  );
  if (!input) return { rooms: [], labels, scale };
  const found = await inWorker(input);
  progress(100);

  const toPdf = invert(m);
  return {
    labels,
    scale,
    rooms: found.map((r) => ({
      no: r.seeds.map((k) => labels[k].no).join(" + "),
      name: [...new Set(r.seeds.map((k) => labels[k].name).filter(Boolean))].join(" + "),
      points: Array.from({ length: r.points.length / 2 }, (_, i) => apply(toPdf, [r.points[2 * i] / s, r.points[2 * i + 1] / s])),
    })),
  };
}

function inWorker(input: SegmentInput): Promise<Room[]> {
  const worker = new Worker(new URL("./segment.worker.ts", import.meta.url), { type: "module" });
  return new Promise<Room[]>((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message || "Room detection failed"));
    worker.postMessage(input, [input.walls.buffer, input.lines.buffer, input.seeds.buffer, input.doors!.buffer]);
  }).finally(() => worker.terminate());
}
