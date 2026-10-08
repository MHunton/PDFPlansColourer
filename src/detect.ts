// Room detection input from a page's operator list: which paths are barriers, rasterised here (not by pdf.js),
// plus room labels from the text layer or, when the drawing has none, from glyphs drawn as filled shapes (ocr.ts).
// No DOM imports: runs in Node too (canvas factory passed in), so it can be checked against real drawings.
import { apply, type Mat, type Pt } from "./coords.ts";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { findDoors, type Seg as Line } from "./doors.ts";
import { readText, tracePath, yieldNow, type Glyph } from "./ocr.ts";
import { code, drawingScale, roomLabels, type RoomLabel, type TextItem } from "./roomLabels.ts";
import type { SegmentInput } from "./segment.ts";

const MAX_PX = 16e6;   // raster budget: A0 lands at ~1.4 px/pt (a 0.24 pt door arc is still a continuous barrier)
const TILE = 4096;     // iOS canvas area limit
const DOOR_HALF_M = 0.55, ENTRANCE_HALF_M = 2, MIN_ROOM_M2 = 0.4, MAX_ROOM_M2 = 2000;

export type MakeCanvas = (w: number, h: number) => HTMLCanvasElement;
export interface PageData {
  ops: { fnArray: number[]; argsArray: unknown[] };
  items: TextItem[];
  view: { width: number; height: number; transform: Mat }; // pdf.js viewport at scale 1, page's own rotation
}
export interface Prepared {
  items: TextItem[];          // text layer, or text read from glyph shapes
  input: SegmentInput | null; // null: no labels, nothing to trace
  labels: RoomLabel[];
  scale: number | null;
  s: number;                  // raster px per pt
}

export async function prepare(page: PageData, makeCanvas: MakeCanvas, progress: (pct: number) => void = () => {}): Promise<Prepared> {
  const { view } = page;
  const paths = parsePaths(page.ops);
  // No text layer (text drawn as shapes): read the shapes. Shapes that read as text are never barriers.
  const read = page.items.some((i) => i.str.trim()) ? { items: page.items, text: new Set<number>() } : await readText(textFills(paths), makeCanvas, (f) => progress(f * 60));
  const items = read.items;
  const labels = roomLabels(items);
  let scale = drawingScale(items.map((i) => i.str).join(" "));
  progress(60);
  scale ??= scaleFromDoors(paths);
  const s = Math.min(2, Math.sqrt(MAX_PX / (view.width * view.height))); // px per pt
  if (!labels.length) return { input: null, items, labels, scale, s };

  const ptPerM = 72 / 0.0254 / (scale ?? 100); // unknown scale: assume 1:100
  const numbers = new Set(labels.map((l) => l.no));
  const tags = items.filter((i) => /^\S*\d\S*$/.test(i.str.trim()) && !numbers.has(code(i))).map(textBox);
  const keep = operatorFilters(paths, read.text, tags, ptPerM);
  const m = view.transform, w = Math.ceil(view.width * s), h = Math.ceil(view.height * s);
  await yieldNow();
  const walls = rasterise(paths, keep.walls, m, s, w, h, makeCanvas);
  progress(80);
  await yieldNow();
  const lines = rasterise(paths, keep.lines, m, s, w, h, makeCanvas);
  progress(100);

  const pxPerM = ptPerM * s;
  const px = (p: Pt) => apply(m, p).map((v) => v * s - 0.5);
  return {
    items, labels, scale, s,
    input: {
      w, h, walls, lines,
      seeds: new Float32Array(labels.flatMap((l) => px(l.at))),
      alt: new Float32Array(labels.flatMap((l) => (l.nameAt ? px(l.nameAt) : [NaN, NaN]))),
      doors: new Float32Array(keep.doors.flatMap((d) => [...px(d.h), ...px(d.e)])),
      closeR: Math.max(1, Math.round(DOOR_HALF_M * pxPerM)),
      sealR: Math.max(2, Math.round(ENTRANCE_HALF_M * pxPerM)),
      minArea: MIN_ROOM_M2 * pxPerM ** 2,
      // bigger = the space around the building (or part of it, cut off by site lines); a hall is well under 2000 m²
      maxArea: Math.min(0.3 * w * h, MAX_ROOM_M2 * pxPerM ** 2),
    },
  };
}

// ---- operator list -> paths (PDF space) ----

/** A painted path: `d` is pdf.js path data with every point already in PDF space. */
interface Path {
  i: number; d: Float32Array; paint: number; weight: number; dashed: boolean;
  stroke: number[]; fill: number[]; box: number[]; // x0, y0, x1, y1 (PDF pt)
  len: number; hatch: boolean; closed: boolean; lines: Line[];
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
const EVENODD = new Set([OPS.eoFill, OPS.eoFillStroke, OPS.closeEOFillStroke]);

/** Painted paths with graphics state applied. Clipping paths (endPath) are skipped: barriers don't need clips. */
function parsePaths(ol: PageData["ops"]): Path[] {
  const paths: Path[] = [];
  let ctm: Mat = [1, 0, 0, 1, 0, 0], lw = 1, stroke = [0, 0, 0], fill = [0, 0, 0], dashed = false;
  const stack: [Mat, number, number[], number[], boolean][] = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i], a = ol.argsArray[i] as any;
    if (f === OPS.save || f === OPS.paintFormXObjectBegin) {
      stack.push([ctm, lw, stroke, fill, dashed]);
      if (f === OPS.paintFormXObjectBegin && a?.[0]) ctm = mul(ctm, a[0]);
    } else if (f === OPS.restore || f === OPS.paintFormXObjectEnd) [ctm, lw, stroke, fill, dashed] = stack.pop() ?? [ctm, lw, stroke, fill, dashed];
    else if (f === OPS.transform) ctm = mul(ctm, a);
    else if (f === OPS.setLineWidth) lw = a[0];
    else if (f === OPS.setDash) dashed = a[0]?.length > 0;
    else if (f === OPS.setGState) { for (const [k, v] of a[0]) { if (k === "LW") lw = v; else if (k === "D") dashed = v[0]?.length > 0; } }
    else if (f === OPS.setStrokeRGBColor) stroke = rgb(a[0]);
    else if (f === OPS.setFillRGBColor) fill = rgb(a[0]);
    else if (f === OPS.setStrokeTransparent) stroke = [255, 255, 255];
    else if (f === OPS.setFillTransparent) fill = [255, 255, 255];
    else if (f === OPS.constructPath && (STROKES.has(a[0]) || FILLS.has(a[0]))) {
      const src = a[1][0] as ArrayLike<number>, d = new Float32Array(src.length);
      const path: Path = {
        i, d, paint: a[0], weight: Math.round(lw * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) * 100) / 100, dashed,
        stroke, fill, box: [0, 0, 0, 0], len: 0, hatch: false, closed: false, lines: [],
      };
      let prev: Pt | null = null, diagonal = 0, straight = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const put = (k: number): Pt => {
        const p = apply(ctm, [src[k], src[k + 1]]);
        d[k] = p[0]; d[k + 1] = p[1];
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
        return p;
      };
      for (let k = 0; k < src.length;) {
        const op = d[k] = src[k++];
        if (op === 0 || op === 1) {
          const p = put(k);
          k += 2;
          if (op === 1 && prev) {
            const dx = Math.abs(p[0] - prev[0]), dy = Math.abs(p[1] - prev[1]), l = Math.hypot(dx, dy);
            path.len += l;
            path.lines.push({ i, a: prev, b: p });
            if (l > 10 && dx > 0.3 * l && dy > 0.3 * l) diagonal++; else straight++; // door arcs: many short segments
          }
          prev = p;
        } else if (op === 2 || op === 3) { // curves: end point counts for the size, not for length
          const n = op === 2 ? 6 : 4;
          for (let j = 0; j < n; j += 2) prev = put(k + j);
          k += n;
        } else path.closed = true; // closePath
      }
      path.box = [x0, y0, x1, y1];
      path.hatch = diagonal > 0 && !straight; // only long diagonal strokes: hatching (door arcs are short segments)
      paths.push(path);
    }
  }
  return paths;
}

const size = (p: Path) => Math.max(p.box[2] - p.box[0], p.box[3] - p.box[1]);

/**
 * Fills that may be text drawn as shapes (CAD printed via GDI draws each glyph as a filled polygon): small and dark.
 * Triangles are left out: they are pieces of triangulated wall infill. Whether a group of them is text is decided
 * by reading it (ocr.ts). Sizes in pt on paper: drafting text is sized on paper, whatever the drawing scale.
 */
function textFills(paths: Path[]): Glyph[] {
  const vertices = (p: Path) => { let n = 0; for (let k = 0; k < p.d.length;) { const op = p.d[k++]; if (op <= 1) { n++; k += 2; } else if (op === 2) { n += 3; k += 6; } else if (op === 3) { n += 2; k += 4; } } return n; };
  return paths.filter((p) => FILLS.has(p.paint) && !STROKES.has(p.paint) && size(p) < 12 && lum(p.fill) < 200 && vertices(p) > 3)
    .map((p) => ({ i: p.i, d: p.d, box: p.box, evenOdd: EVENODD.has(p.paint) }));
}

/**
 * Drawing scale when the text doesn't say: door swings are ~0.85 m whatever the scale. Median swing radius in pt,
 * rounded to the nearest usual scale. Null if the drawing has too few doors to tell.
 */
function scaleFromDoors(paths: Path[]): number | null {
  const thin = paths.filter((p) => STROKES.has(p.paint) && darkNeutral(p.stroke) && !p.hatch).flatMap((p) => p.lines);
  const { radii } = findDoors(thin, 2, 120); // 0.4 m at 1:500 .. 1.6 m at 1:50, in pt
  if (radii.length < 5) return null;
  const r = radii.sort((a, b) => a - b)[radii.length >> 1], scale = 72 / 0.0254 / (r / 0.85);
  return [50, 100, 200, 500].reduce((best, s) => (Math.abs(Math.log(s / scale)) < Math.abs(Math.log(best / scale)) ? s : best));
}

// ---- barrier selection ----

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
 * Paths drawing a rectangle tight around a tag (e.g. "FES.Z4.L3.06"): four axis-aligned segments, one per
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
 * Which paths go into each barrier raster. Walls: wall-weight strokes in black/grey or the drawing's wall
 * colour + non-light fills. Lines: walls + thin black/grey strokes except hatching (door arcs and leaves, glazing;
 * coloured thin lines are hatching or annotation). Text (glyph fills too), dashed lines and tag boxes never.
 * Wall weight comes from the drawing: the most-used dark stroke weight well above the most-used (detail) one.
 * Fills that are small and coloured (exit signs, call points, door markers) or tiny (symbols, dots) are ignored,
 * so they neither split a room nor cut notches into it. `ptPerM`: drawing scale, pt per real metre.
 */
function operatorFilters(paths: Path[], text: Set<number>, tags: Box[], ptPerM: number) {
  const walls = new Set<number>(), lines = new Set<number>();
  const segs: Seg[] = [], lengthByWeight = new Map<number, number>();
  for (const p of paths) {
    if (!STROKES.has(p.paint)) continue;
    for (const l of p.lines) if (Math.abs(l.a[0] - l.b[0]) < 0.3 || Math.abs(l.a[1] - l.b[1]) < 0.3) segs.push({ i: p.i, x0: l.a[0], y0: l.a[1], x1: l.b[0], y1: l.b[1] });
    if (darkNeutral(p.stroke)) lengthByWeight.set(p.weight, (lengthByWeight.get(p.weight) ?? 0) + p.len);
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
  const CELL = 20, signs = new Map<string, number[][]>(), m = (p: Path) => size(p) / ptPerM; // m: size in metres
  const width = (p: Path) => Math.min(p.box[2] - p.box[0], p.box[3] - p.box[1]) / ptPerM;
  const isSign = (p: Path) => FILLS.has(p.paint) && lum(p.fill) < 200 && !darkNeutral(p.fill) && m(p) >= 0.2 && m(p) < 2 && !(m(p) >= 1.2 && width(p) <= 0.35);
  // A small symbol's frame can be bigger than its coloured part (call point: red half, white half): half its size of slack.
  for (const p of paths) if (isSign(p)) {
    const pad = m(p) < 0.6 ? 0.5 * size(p) : 1; // big signs: their own box
    const [x0, y0, x1, y1] = [p.box[0] - pad, p.box[1] - pad, p.box[2] + pad, p.box[3] + pad];
    for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) (signs.get(`${x},${y}`) ?? signs.set(`${x},${y}`, []).get(`${x},${y}`)!).push([x0, y0, x1, y1]);
  }
  const inSign = ([x0, y0, x1, y1]: number[]) => (signs.get(`${Math.floor(x0 / CELL)},${Math.floor(y0 / CELL)}`) ?? [])
    .some((b) => x0 >= b[0] && y0 >= b[1] && x1 <= b[2] && y1 <= b[3]);

  for (const p of paths) {
    if (boxes.has(p.i) || text.has(p.i) || p.dashed || inSign(p.box)) continue;
    const stroke = STROKES.has(p.paint), thick = p.weight >= thinPt;
    // light fills are room tints/masks; small coloured or tiny ones are symbols. Neither is a wall.
    // coloured fills only count when wall-shaped (long, at most wall-thick): fire exit signs are fat green boxes
    const solid = FILLS.has(p.paint) && lum(p.fill) < 200 && m(p) >= 0.35 && (darkNeutral(p.fill) || m(p) >= 1.2 && width(p) <= 0.35);
    if (stroke && thick && (darkNeutral(p.stroke) || String(p.stroke) === wallColour) || solid) walls.add(p.i);
    // small closed thin outlines (circled letters, sanitaryware, furniture) are symbols, not room edges
    if (stroke && (thick || darkNeutral(p.stroke) && !p.hatch && !(p.closed && m(p) < 1)) || solid) lines.add(p.i);
  }
  // Door symbols: their arcs and leaves aren't barriers; the doorway line (hinge to closed end) is drawn instead.
  const thin = paths.filter((p) => STROKES.has(p.paint) && p.weight < thinPt && darkNeutral(p.stroke) && !p.hatch).flatMap((p) => p.lines);
  const { doors, ops } = findDoors(thin, 0.4 * ptPerM, 1.6 * ptPerM);
  for (const i of ops) lines.delete(i);
  return { walls, lines, doors };
}

// ---- rasterising ----

/**
 * Draw the kept paths black on white, in tiles; 1 = barrier (anything clearly not white). Lines get at least
 * 1 px, as pdf.js draws hairlines. Drawn here rather than by pdf.js with an operator filter: pdf.js merges
 * save/transform/path/restore runs when rendering, so its operator indices don't match getOperatorList().
 */
function rasterise(paths: Path[], keep: Set<number>, m: Mat, s: number, w: number, h: number, makeCanvas: MakeCanvas): Uint8Array {
  const mask = new Uint8Array(w * h), canvas = makeCanvas(Math.min(TILE, w), Math.min(TILE, h));
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
  const kept = paths.filter((p) => keep.has(p.i)), k = s * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  for (let ty = 0; ty < h; ty += TILE) {
    for (let tx = 0; tx < w; tx += TILE) {
      const tw = Math.min(TILE, w - tx), th = Math.min(TILE, h - ty);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, tw, th);
      ctx.fillStyle = ctx.strokeStyle = "#000";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // page -> tile pixels
      const t: Mat = [m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s - tx, m[5] * s - ty];
      ctx.setTransform(...t);
      for (const p of kept) {
        const [a, b] = apply(t, [p.box[0], p.box[1]]), [c, d] = apply(t, [p.box[2], p.box[3]]);
        if (Math.max(a, c) < -4 || Math.min(a, c) > tw + 4 || Math.max(b, d) < -4 || Math.min(b, d) > th + 4) continue;
        ctx.beginPath();
        tracePath(ctx, p.d);
        if (STROKES.has(p.paint)) { ctx.lineWidth = Math.max(p.weight * k, 1) / k; ctx.stroke(); }
        else ctx.fill(EVENODD.has(p.paint) ? "evenodd" : "nonzero");
      }
      const px = ctx.getImageData(0, 0, tw, th).data;
      for (let y = 0; y < th; y++) {
        const row = (ty + y) * w + tx;
        for (let x = 0, i = y * tw * 4; x < tw; x++, i += 4) mask[row + x] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 < 235 ? 1 : 0;
      }
    }
  }
  canvas.width = 0;
  return mask;
}
