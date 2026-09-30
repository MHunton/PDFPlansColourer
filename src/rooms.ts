// Automatic room detection: room-number text gives seeds; two filtered renders of the page give barrier rasters;
// a worker flood-fills from each seed and traces outlines (see segment.ts). Returns polygons in PDF space.
import { apply, invert, type Mat, type Pt } from "./coords";
import { OPS, renderRegion, type PDFPageProxy } from "./pdf";
import { findDoors, type Seg as Line } from "./doors";
import { drawingScale, roomLabels, type RoomLabel, type TextItem } from "./roomLabels";
import type { Room, SegmentInput } from "./segment";

const MAX_PX = 16e6;   // raster budget: A0 lands at ~1.4 px/pt (a 0.24 pt door arc is still a continuous barrier)
const TILE = 4096;     // iOS canvas area limit
const DOOR_HALF_M = 0.55, ENTRANCE_HALF_M = 2, MIN_ROOM_M2 = 0.4;

export interface DetectedRoom { no: string; name: string; points: Pt[] }
/** `labels`: every room label found in the text, traced or not. */
export interface Detection { rooms: DetectedRoom[]; labels: RoomLabel[]; scale: number | null }

export async function detectRooms(page: PDFPageProxy, progress: (pct: number) => void = () => {}): Promise<Detection> {
  const items = (await page.getTextContent()).items.filter((i) => "str" in i) as TextItem[];
  const labels = roomLabels(items);
  const scale = drawingScale(items.map((i) => i.str).join(" "));
  if (!labels.length) return { rooms: [], labels, scale };

  const numbers = new Set(labels.map((l) => l.no));
  const tags = items.filter((i) => /^\S*\d\S*$/.test(i.str.trim()) && !numbers.has(i.str.trim())).map(textBox);
  const keep = operatorFilters(await page.getOperatorList(), tags, 72 / 0.0254 / (scale ?? 100));
  const vp = page.getViewport({ scale: 1 });
  const m = vp.transform as Mat;
  const s = Math.min(2, Math.sqrt(MAX_PX / (vp.width * vp.height))); // px per pt
  const w = Math.ceil(vp.width * s), h = Math.ceil(vp.height * s);
  const walls = await rasterise(page, s, w, h, keep.walls, (p) => progress(p * 0.4));
  const lines = await rasterise(page, s, w, h, keep.lines, (p) => progress(40 + p * 0.4));
  progress(80);

  const pxPerM = (72 / 0.0254 / (scale ?? 100)) * s; // unknown scale: assume 1:100
  const px = (p: Pt) => apply(m, p).map((v) => v * s - 0.5);
  const seeds = new Float32Array(labels.flatMap((l) => px(l.at)));
  const alt = new Float32Array(labels.flatMap((l) => (l.nameAt ? px(l.nameAt) : [NaN, NaN])));
  const doors = new Float32Array(keep.doors.flatMap((d) => [...px(d.h), ...px(d.e)]));
  const found = await inWorker({
    w, h, walls, lines, seeds, alt, doors,
    closeR: Math.max(1, Math.round(DOOR_HALF_M * pxPerM)),
    sealR: Math.max(2, Math.round(ENTRANCE_HALF_M * pxPerM)),
    minArea: MIN_ROOM_M2 * pxPerM ** 2,
    maxArea: 0.3 * w * h, // bigger = the space around the building; shared spaces are split per label anyway
  });
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

/** Render the page with only the kept operators, in tiles; 1 = barrier (anything clearly not white). */
async function rasterise(page: PDFPageProxy, s: number, w: number, h: number, keep: (i: number) => boolean, progress: (pct: number) => void) {
  const mask = new Uint8Array(w * h);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true })!; // pdf.js reuses this context
  const tiles = Math.ceil(w / TILE) * Math.ceil(h / TILE);
  let done = 0;
  for (let ty = 0; ty < h; ty += TILE) {
    for (let tx = 0; tx < w; tx += TILE) {
      const tw = Math.min(TILE, w - tx), th = Math.min(TILE, h - ty);
      await renderRegion(page, canvas, s, tx / s, ty / s, tw / s, th / s, keep).done;
      const px = ctx.getImageData(0, 0, tw, th).data;
      for (let y = 0; y < th; y++) {
        const row = (ty + y) * w + tx;
        for (let x = 0, i = y * tw * 4; x < tw; x++, i += 4) mask[row + x] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 < 235 ? 1 : 0;
      }
      progress((++done / tiles) * 100);
    }
  }
  canvas.width = 0;
  return mask;
}

const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
const lum = ([r, g, b]: number[]) => r * 0.299 + g * 0.587 + b * 0.114;
const darkNeutral = (c: number[]) => Math.max(...c) < 130 && Math.max(...c) - Math.min(...c) < 60; // black/dark grey

const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const FILLS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const TEXT = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
const IMAGES = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup]);

/** Axis-aligned PDF-space box of a text item, and its line height. */
function textBox(it: TextItem) {
  const [a, b, c, d, e, f] = it.transform, n1 = Math.hypot(a, b) || 1, n2 = Math.hypot(c, d) || 1;
  const dx = (a / n1) * it.width, dy = (b / n1) * it.width, ux = (c / n2) * it.height, uy = (d / n2) * it.height;
  const xs = [e, e + dx, e + ux, e + dx + ux], ys = [f, f + dy, f + uy, f + dy + uy];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), h: it.height || 1 };
}
type Box = ReturnType<typeof textBox>;
interface Seg { i: number; x0: number; y0: number; x1: number; y1: number }

/**
 * Operators drawing a rectangle tight around a tag (e.g. "FES.Z4.L3.06"): four axis-aligned segments, one per
 * side, within 2.5 line heights of the text and no longer than the box. Drawn at wall weight, they would
 * otherwise wall off part of the corridor they sit in.
 */
function tagBoxOps(segs: Seg[], tags: Box[]): Set<number> {
  const skip = new Set<number>();
  for (const t of tags) {
    const m = 2.5 * t.h, tol = 0.25 * t.h;
    const side: Record<"l" | "r" | "b" | "t", { i: number; d: number } | null> = { l: null, r: null, b: null, t: null };
    const take = (k: keyof typeof side, i: number, d: number) => { if (!side[k] || d < side[k]!.d) side[k] = { i, d }; };
    for (const s of segs) {
      if (Math.abs(s.x0 - s.x1) < 0.3) { // vertical
        const lo = Math.min(s.y0, s.y1), hi = Math.max(s.y0, s.y1);
        if (lo > t.y0 + tol || hi < t.y1 - tol || hi - lo > t.y1 - t.y0 + 2 * m) continue;
        if (s.x0 <= t.x0 + tol && s.x0 >= t.x0 - m) take("l", s.i, t.x0 - s.x0);
        if (s.x0 >= t.x1 - tol && s.x0 <= t.x1 + m) take("r", s.i, s.x0 - t.x1);
      } else if (Math.abs(s.y0 - s.y1) < 0.3) { // horizontal
        const lo = Math.min(s.x0, s.x1), hi = Math.max(s.x0, s.x1);
        if (lo > t.x0 + tol || hi < t.x1 - tol || hi - lo > t.x1 - t.x0 + 2 * m) continue;
        if (s.y0 <= t.y0 + tol && s.y0 >= t.y0 - m) take("b", s.i, t.y0 - s.y0);
        if (s.y0 >= t.y1 - tol && s.y0 <= t.y1 + m) take("t", s.i, s.y0 - t.y1);
      }
    }
    if (side.l && side.r && side.b && side.t) for (const v of Object.values(side)) skip.add(v!.i);
  }
  return skip;
}

/**
 * Which operators to draw for each barrier raster. Walls: wall-weight strokes in black/grey or the drawing's wall
 * colour + non-light fills. Lines: walls +
 * thin black/grey strokes except hatching (door arcs and leaves, glazing; coloured thin lines are hatching or
 * annotation). Text, images and
 * tag boxes never. Graphics-state ops are always kept so colours, clips and transforms stay correct.
 * Wall weight comes from the drawing: the most-used dark stroke weight well above the most-used (detail) one.
 * Fills that are small and coloured (exit signs, call points, door markers) or tiny (symbols, dots) are ignored,
 * so they neither split a room nor cut notches into it. `ptPerM`: drawing scale, pt per real metre.
 */
function operatorFilters(ol: { fnArray: number[]; argsArray: unknown[] }, tags: Box[], ptPerM: number) {
  const n = ol.fnArray.length, walls = new Uint8Array(n).fill(1), lines = new Uint8Array(n).fill(1);
  const paths: { i: number; weight: number; stroke: number[]; fill: number[]; paint: number; len: number; hatch: boolean; size: number; width: number; box: number[]; symbol: boolean; lines: Line[] }[] = [];
  const segs: Seg[] = [], lengthByWeight = new Map<number, number>();
  let ctm: Mat = [1, 0, 0, 1, 0, 0], lw = 1, stroke = [0, 0, 0], fill = [0, 0, 0];
  const stack: [Mat, number, number[], number[]][] = [];
  for (let i = 0; i < n; i++) {
    const f = ol.fnArray[i], a = ol.argsArray[i] as any;
    if (f === OPS.save || f === OPS.paintFormXObjectBegin) {
      stack.push([ctm, lw, stroke, fill]);
      if (f === OPS.paintFormXObjectBegin && a?.[0]) ctm = mul(ctm, a[0]);
    } else if (f === OPS.restore || f === OPS.paintFormXObjectEnd) [ctm, lw, stroke, fill] = stack.pop() ?? [ctm, lw, stroke, fill];
    else if (f === OPS.transform) ctm = mul(ctm, a);
    else if (f === OPS.setLineWidth) lw = a[0];
    else if (f === OPS.setGState) { for (const [k, v] of a[0]) if (k === "LW") lw = v; }
    else if (f === OPS.setStrokeRGBColor) stroke = rgb(a[0]);
    else if (f === OPS.setFillRGBColor) fill = rgb(a[0]);
    else if (f === OPS.setStrokeTransparent) stroke = [255, 255, 255];
    else if (f === OPS.setFillTransparent) fill = [255, 255, 255];
    else if (TEXT.has(f) || IMAGES.has(f)) walls[i] = lines[i] = 0;
    else if (f === OPS.constructPath && (STROKES.has(a[0]) || FILLS.has(a[0]))) { // endPath = clipping path: keep
      const weight = Math.round(lw * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) * 100) / 100;
      const path = { i, weight, stroke, fill, paint: a[0], len: 0, hatch: false, size: 0, width: 0, box: [0, 0, 0, 0], symbol: false, lines: [] as Line[] };
      paths.push(path);
      const d = a[1][0] as ArrayLike<number>;
      let len = 0, prev: Pt | null = null, diagonal = 0, straight = 0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, closed = false;
      for (let k = 0; k < d.length;) {
        const op = d[k++];
        if (op === 0 || op === 1) {
          const p = apply(ctm, [d[k], d[k + 1]]);
          k += 2;
          x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
          if (op === 1 && prev) {
            const dx = Math.abs(p[0] - prev[0]), dy = Math.abs(p[1] - prev[1]), l = Math.hypot(dx, dy);
            len += l;
            path.lines.push({ i, a: prev, b: p });
            if (l > 10 && dx > 0.3 * l && dy > 0.3 * l) diagonal++; else straight++; // door arcs: many short segments
            if (Math.abs(p[0] - prev[0]) < 0.3 || Math.abs(p[1] - prev[1]) < 0.3) segs.push({ i, x0: prev[0], y0: prev[1], x1: p[0], y1: p[1] });
          }
          prev = p;
        } else if (op === 2 || op === 3) { // curves: end point counts for the size, not for length
          const n = op === 2 ? 6 : 4, p = apply(ctm, [d[k + n - 2], d[k + n - 1]]);
          x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
          k += n;
          prev = p;
        } else closed = true; // closePath
      }
      path.size = Math.max(x1 - x0, y1 - y0) / ptPerM; // m
      path.width = Math.min(x1 - x0, y1 - y0) / ptPerM;
      path.box = [x0, y0, x1, y1];
      path.symbol = closed && path.size < 1;
      if (!STROKES.has(a[0])) continue;
      path.len = len;
      path.hatch = diagonal > 0 && !straight; // only long diagonal strokes: hatching (door arcs are short segments)
      if (darkNeutral(stroke)) lengthByWeight.set(weight, (lengthByWeight.get(weight) ?? 0) + len);
    }
  }

  const byLength = [...lengthByWeight].sort((p, q) => q[1] - p[1]);
  const detail = byLength[0];
  const wall = detail && byLength.find(([wt, len]) => wt >= 1.5 * detail[0] && len >= 0.2 * detail[1]);
  const thinPt = wall ? 0.75 * wall[0] : 0.5;
  // Wall colour: the colour with most thick-line length (black here). Thick lines in other colours are overlays
  // (fire-rating lines on walls, dashed site boundaries), not walls; the walls under them are drawn anyway.
  const lengthByColour = new Map<string, number>();
  for (const p of paths) if (STROKES.has(p.paint) && p.weight >= thinPt) lengthByColour.set(String(p.stroke), (lengthByColour.get(String(p.stroke)) ?? 0) + p.len);
  const wallColour = [...lengthByColour].sort((p, q) => q[1] - p[1])[0]?.[0];
  const boxes = tagBoxOps(segs, tags);

  // Coloured symbols (fire exit signs, call points): the fill and every line drawn within it (border, pictogram).
  const CELL = 20, signs = new Map<string, number[][]>();
  const isSign = (p: (typeof paths)[number]) => FILLS.has(p.paint) && lum(p.fill) < 200 && !darkNeutral(p.fill) && p.size >= 0.2 && p.size < 2 && !(p.size >= 1.2 && p.width <= 0.35);
  for (const p of paths) if (isSign(p)) {
    const [x0, y0, x1, y1] = p.box;
    for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) (signs.get(`${x},${y}`) ?? signs.set(`${x},${y}`, []).get(`${x},${y}`)!).push(p.box);
  }
  const inSign = ([x0, y0, x1, y1]: number[]) => (signs.get(`${Math.floor(x0 / CELL)},${Math.floor(y0 / CELL)}`) ?? [])
    .some((b) => x0 >= b[0] - 1 && y0 >= b[1] - 1 && x1 <= b[2] + 1 && y1 <= b[3] + 1);

  for (const { i, weight, stroke: sc, fill: fc, paint, hatch, size, width, box, symbol } of paths) {
    if (boxes.has(i) || inSign(box)) { walls[i] = lines[i] = 0; continue; }
    const thick = weight >= thinPt;
    // light fills are room tints/masks; small coloured or tiny ones are symbols. Neither is a wall.
    // coloured fills only count when wall-shaped (long, at most wall-thick): fire exit signs are fat green boxes
    const solid = FILLS.has(paint) && lum(fc) < 200 && size >= 0.35 && (darkNeutral(fc) || size >= 1.2 && width <= 0.35);
    walls[i] = STROKES.has(paint) && thick && (darkNeutral(sc) || String(sc) === wallColour) || solid ? 1 : 0;
    // small closed thin outlines (circled letters, sanitaryware, furniture) are symbols, not room edges
    lines[i] = STROKES.has(paint) && (thick || darkNeutral(sc) && !hatch && !symbol) || solid ? 1 : 0;
  }
  // Door symbols: their arcs and leaves aren't barriers; the doorway line (hinge to closed end) is drawn instead.
  const thin = paths.filter((p) => STROKES.has(p.paint) && p.weight < thinPt && darkNeutral(p.stroke) && !p.hatch).flatMap((p) => p.lines);
  const { doors, ops } = findDoors(thin, 0.4 * ptPerM, 1.6 * ptPerM);
  for (const i of ops) lines[i] = 0;
  return { walls: (i: number) => walls[i] === 1, lines: (i: number) => lines[i] === 1, doors };
}
