// Reading text that a drawing draws as filled shapes (no text layer: CAD printed via GDI turns every glyph into
// triangles). Glyph pieces are grouped into blocks, each block is rasterised upright in all four orientations,
// split into lines and characters, and each character matched against Arial rendered by the canvas (drafting
// text is almost always Arial/Helvetica). The orientation that matches best wins. Output is pdf.js-style text
// items, so room labels and the drawing scale are found from them exactly as from a real text layer.
import { apply, invert, type Mat } from "./coords.ts";
import type { MakeCanvas } from "./detect.ts";
import type { TextItem } from "./roomLabels.ts";

/** A filled path that is part of a glyph; `d` is pdf.js path data in PDF space. */
export interface Glyph { i: number; d: Float32Array; box: number[]; evenOdd: boolean }

const CHARS = [..."0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,-/&()+:'²", "ff", "fi", "ft", "tt", "rt"]; // pairs that touch
const GW = 10, GH = 14;   // character grid
const PX_PER_PT = 8;      // block raster resolution (5 pt drafting text ~40 px)
const GAP_PT = 2;         // pieces this close belong to one block (letters, words, label lines)
const CAP = 0.716;        // Arial cap/digit height, em

interface Shape { grid: Float32Array; aspect: number; top: number; bottom: number; holes: number } // top/bottom: em above baseline
interface Tpl extends Shape { ch: string }
interface Comp { x0: number; y0: number; x1: number; y1: number; px: number[] } // x1/y1 exclusive; px: pixel indices

let tpls: Tpl[] | null = null;
/** Each character of CHARS drawn in Arial, as a grid + metrics. */
function templates(makeCanvas: MakeCanvas): Tpl[] {
  if (tpls) return tpls;
  const S = 100, W = 200, base = 150, c = makeCanvas(W, W), ctx = c.getContext("2d", { willReadFrequently: true })!;
  tpls = [];
  for (const weight of ["", "bold "]) for (const ch of CHARS) { // regular and bold (labels are often bold)
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = "#000";
    ctx.font = `${weight}${S}px Arial, Helvetica, sans-serif`;
    ctx.fillText(ch, 40, base);
    const ink = toInk(ctx.getImageData(0, 0, W, W).data);
    const all: number[] = [];
    ink.forEach((v, p) => v && all.push(p));
    if (!all.length) continue;
    const comp = bounds(all, W);
    tpls.push({ ch, ...shape(ink, W, comp, base, S) });
  }
  return tpls;
}

const toInk = (rgba: Uint8ClampedArray) => {
  const ink = new Uint8Array(rgba.length / 4);
  for (let p = 0; p < ink.length; p++) ink[p] = rgba[4 * p] * 0.299 + rgba[4 * p + 1] * 0.587 + rgba[4 * p + 2] * 0.114 < 200 ? 1 : 0;
  return ink;
};

function bounds(px: number[], w: number): Comp {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of px) { const x = p % w, y = (p / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1, px };
}

/** Grid of ink coverage over the component's box, aspect and vertical position (em above `base`). */
function shape(ink: Uint8Array, w: number, c: Comp, base: number, em: number): Shape {
  const grid = new Float32Array(GW * GH), bw = c.x1 - c.x0, bh = c.y1 - c.y0;
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) { // each cell averages at least one pixel
    const xa = c.x0 + Math.floor((gx * bw) / GW), ya = c.y0 + Math.floor((gy * bh) / GH);
    const xb = Math.max(xa + 1, c.x0 + Math.floor(((gx + 1) * bw) / GW)), yb = Math.max(ya + 1, c.y0 + Math.floor(((gy + 1) * bh) / GH));
    let s = 0;
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) s += ink[y * w + x];
    grid[gy * GW + gx] = s / ((xb - xa) * (yb - ya));
  }
  return { grid, aspect: Math.log(bw / bh), top: (base - c.y0) / em, bottom: (base - c.y1) / em, holes: holes(ink, w, c) };
}

/** Enclosed white areas in the component's box (8: 2, 6: 1, 5: 0): survives the blur that makes 6 and 8 alike. */
function holes(ink: Uint8Array, w: number, c: Comp): number {
  const bw = c.x1 - c.x0 + 2, bh = c.y1 - c.y0 + 2, seen = new Uint8Array(bw * bh), stack: number[] = [];
  const white = (x: number, y: number) => x < 1 || y < 1 || x > bw - 2 || y > bh - 2 || !ink[(y - 1 + c.y0) * w + x - 1 + c.x0];
  let n = -1; // the first area found is the outside (padding ring)
  for (let p0 = 0; p0 < seen.length; p0++) {
    if (seen[p0] || !white(p0 % bw, (p0 / bw) | 0)) continue;
    let area = 0;
    seen[p0] = 1; stack.push(p0);
    while (stack.length) {
      const p = stack.pop()!, x = p % bw, y = (p / bw) | 0;
      area++;
      for (const [X, Y] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const q = Y * bw + X;
        if (X >= 0 && Y >= 0 && X < bw && Y < bh && !seen[q] && white(X, Y)) { seen[q] = 1; stack.push(q); }
      }
    }
    if (n < 0 || area >= 2) n++; // single stray pixels aren't holes
  }
  return n;
}

function match(s: Shape, t: Tpl[]): { ch: string; d: number } {
  let best = { ch: "?", d: Infinity };
  for (const tp of t) {
    let g = 0;
    for (let k = 0; k < s.grid.length; k++) g += Math.abs(s.grid[k] - tp.grid[k]);
    const d = g / s.grid.length + 0.25 * Math.min(2, Math.abs(s.aspect - tp.aspect)) + Math.abs(s.top - tp.top) + Math.abs(s.bottom - tp.bottom) + (s.holes !== tp.holes && /\d/.test(tp.ch) ? 0.15 : 0); // holes: 6 vs 8 (letters' holes are less reliable)
    if (d < best.d) best = { ch: tp.ch, d };
  }
  return best;
}

/** Groups of glyph pieces whose boxes come within GAP_PT of each other (union-find over a grid). */
function blocks(glyphs: Glyph[]): Glyph[][] {
  const parent = glyphs.map((_, k) => k), find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const CELL = 8, grid = new Map<string, number[]>();
  glyphs.forEach((g, k) => { // every cell its box comes within GAP_PT of: any two pieces that close share a cell
    for (let x = Math.floor((g.box[0] - GAP_PT) / CELL); x <= Math.floor((g.box[2] + GAP_PT) / CELL); x++)
      for (let y = Math.floor((g.box[1] - GAP_PT) / CELL); y <= Math.floor((g.box[3] + GAP_PT) / CELL); y++) (grid.get(`${x},${y}`) ?? grid.set(`${x},${y}`, []).get(`${x},${y}`)!).push(k);
  });
  for (const cell of grid.values()) for (let a = 0; a < cell.length; a++) for (let b = a + 1; b < cell.length; b++) {
    const p = glyphs[cell[a]].box, q = glyphs[cell[b]].box;
    if (p[0] - GAP_PT <= q[2] && q[0] - GAP_PT <= p[2] && p[1] - GAP_PT <= q[3] && q[1] - GAP_PT <= p[3]) parent[find(cell[a])] = find(cell[b]);
  }
  const out = new Map<number, Glyph[]>();
  glyphs.forEach((g, k) => { const r = find(k); (out.get(r) ?? out.set(r, []).get(r)!).push(g); });
  return [...out.values()];
}

const MAX_SCORE = 0.35; // a line's mean character distance above this: not text (wall pieces, symbols, hatching)
const SURE = 0.15;      // below this, don't try the other orientations

/** Text items read from glyph shapes, and which shapes turned out to be text. Yields to the event loop as it goes. */
export async function readText(glyphs: Glyph[], makeCanvas: MakeCanvas, progress: (f: number) => void = () => {}): Promise<{ items: TextItem[]; text: Set<number> }> {
  const items: TextItem[] = [], text = new Set<number>();
  if (!glyphs.length) return { items, text };
  const t = templates(makeCanvas), canvas = makeCanvas(64, 64), all = blocks(glyphs);
  const wins = new Map([[0, 0], [90, 0], [180, 0], [270, 0]]); // a drawing's text mostly runs one way: try that first
  let last = performance.now();
  for (const [k, block] of all.entries()) {
    if (performance.now() - last > 30) { progress(k / all.length); await yieldNow(); last = performance.now(); }
    if (block.length < 2) continue;
    const best = readGlyphs(block, t, canvas, [...wins].sort((a, b) => b[1] - a[1]).map(([d]) => d));
    if (!best?.items.length) continue;
    wins.set(best.deg, wins.get(best.deg)! + 1);
    items.push(...best.items);
    // Text: pieces inside a line that read well. Others in the block (a wall the label touches) stay drawing.
    for (const g of block) if (best.items.some((it) => inLine(it, [(g.box[0] + g.box[2]) / 2, (g.box[1] + g.box[3]) / 2]))) text.add(g.i);
  }
  canvas.width = 0;
  return { items, text };
}

// Yield via MessageChannel, not setTimeout: hidden tabs throttle timers to 1/s (see pdf.ts).
let channel: MessageChannel | null = null;
const waiting: (() => void)[] = [];
export const yieldNow = () => new Promise<void>((r) => {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => waiting.shift()?.();
  }
  waiting.push(r);
  channel.port2.postMessage(0);
});

/** Is PDF point p within text item it's line box (descenders to accents)? */
function inLine(it: TextItem, p: number[]): boolean {
  const [a, b, , , e, f] = it.transform, em = it.height, dx = p[0] - e, dy = p[1] - f;
  const along = (dx * a + dy * b) / em, across = (dy * a - dx * b) / em; // a, b: em * text direction
  return along > -0.1 * em && along < it.width + 0.1 * em && across > -0.3 * em && across < 0.95 * em;
}

/**
 * Read one block in each orientation (in `order`); the best-matching one, or null if nothing looks like characters.
 * Orientation score: mean character distance, each capped so a few non-text pieces don't decide it. Items: the
 * lines that read well.
 */
function readGlyphs(block: Glyph[], t: Tpl[], canvas: HTMLCanvasElement, order = [0, 90, 180, 270]) {
  let best: { score: number; deg: number; items: TextItem[] } | null = null;
  for (const deg of order) {
    if (best && best.score < SURE) break;
    const { ink, W, H, T, R } = drawBlock(block, deg, canvas);
    const runs = readBlock(ink, W, H, t), chars = runs.reduce((n, r) => n + r.chars, 0);
    if (!chars) continue;
    const score = runs.reduce((n, r) => n + r.capped, 0) / chars;
    if (best && score >= best.score) continue;
    const back = invert(T), th = (deg * Math.PI) / 180, dir = [Math.round(Math.cos(th)), Math.round(Math.sin(th))], up = [-dir[1], dir[0]];
    best = {
      score, deg,
      items: runs.filter((r) => r.dist / r.chars <= MAX_SCORE).map((r) => {
        const em = r.em / R, [e, f] = apply(back, [r.x, r.base]);
        return { str: r.str, transform: [dir[0] * em, dir[1] * em, up[0] * em, up[1] * em, e, f], width: r.w / R, height: em };
      }),
    };
  }
  return best;
}

/** Rasterise a block with its text direction `deg` (PDF space, counter-clockwise) running left to right. */
function drawBlock(block: Glyph[], deg: number, canvas: HTMLCanvasElement) {
  const x0 = Math.min(...block.map((g) => g.box[0])), y0 = Math.min(...block.map((g) => g.box[1]));
  const x1 = Math.max(...block.map((g) => g.box[2])), y1 = Math.max(...block.map((g) => g.box[3]));
  const R = Math.min(PX_PER_PT, 1500 / Math.max(x1 - x0, y1 - y0, 1)), pad = 4;
  const th = (deg * Math.PI) / 180, cs = Math.round(Math.cos(th)), sn = Math.round(Math.sin(th));
  // PDF -> canvas: text direction (cs, sn) to +x, its up (-sn, cs) to -y
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [R * (cs * x + sn * y), R * (sn * x - cs * y)]);
  const ox = pad - Math.min(...corners.map((c) => c[0])), oy = pad - Math.min(...corners.map((c) => c[1]));
  const W = Math.ceil(Math.max(...corners.map((c) => c[0])) + ox + pad), H = Math.ceil(Math.max(...corners.map((c) => c[1])) + oy + pad);
  const T: Mat = [R * cs, R * sn, R * sn, -R * cs, ox, oy];
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
  canvas.width = W; canvas.height = H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000";
  ctx.setTransform(...T);
  for (const g of block) { ctx.beginPath(); tracePath(ctx, g.d); ctx.fill(g.evenOdd ? "evenodd" : "nonzero"); }
  return { ink: toInk(ctx.getImageData(0, 0, W, H).data), W, H, T, R };
}

// canvas px: left, baseline, width, em; dist: summed character distance (capped: each at most 0.6)
interface Run { str: string; x: number; base: number; w: number; em: number; dist: number; capped: number; chars: number }

/** Lines (row projection), characters (connected components merged in columns), runs (split at wide gaps). */
function readBlock(ink: Uint8Array, w: number, h: number, t: Tpl[]): Run[] {
  // Not characters: pieces much taller than the block's typical letter, or long bars (a wall the label touches).
  const all = components(ink, w, h), mid = median(all.map((c) => c.y1 - c.y0)) || 1;
  const comps = all.filter((c) => c.y1 - c.y0 <= 2.2 * mid && c.x1 - c.x0 <= 4 * mid);
  // Lines: letter-sized pieces grouped by their middle height (a descender touching the next line doesn't join
  // them); small pieces (dots, ², commas) go to the line they sit in.
  const cy = (c: Comp) => (c.y0 + c.y1) / 2, core = comps.filter((c) => c.y1 - c.y0 >= 0.6 * mid).sort((p, q) => cy(p) - cy(q));
  const lines: Comp[][] = [];
  for (const c of core) {
    const l = lines[lines.length - 1];
    if (l && cy(c) - l.reduce((s, x) => s + cy(x), 0) / l.length < 0.6 * mid) l.push(c); else lines.push([c]);
  }
  for (const c of comps) {
    if (c.y1 - c.y0 >= 0.6 * mid) continue;
    const l = lines.find((l) => cy(c) >= Math.min(...l.map((x) => x.y0)) - 0.3 * mid && cy(c) <= Math.max(...l.map((x) => x.y1)) + 0.1 * mid);
    l?.push(c);
  }

  const runs: Run[] = [];
  for (const line of lines) {
    const inLine = line.sort((p, q) => p.x0 - q.x0), a = Math.min(...line.map((c) => c.y0)), b = Math.max(...line.map((c) => c.y1));
    // one character per column: merge components overlapping in x by half the narrower (i, j, :, %, ")
    const cs: Comp[] = [];
    for (const c of inLine) {
      const p = cs[cs.length - 1];
      if (p && Math.min(p.x1, c.x1) - Math.max(p.x0, c.x0) >= 0.5 * Math.min(p.x1 - p.x0, c.x1 - c.x0)) {
        Object.assign(p, { x0: Math.min(p.x0, c.x0), y0: Math.min(p.y0, c.y0), x1: Math.max(p.x1, c.x1), y1: Math.max(p.y1, c.y1), px: p.px.concat(c.px) });
      } else cs.push({ ...c });
    }
    if (!cs.length) continue;
    const tallC = cs.filter((c) => c.y1 - c.y0 > 0.3 * (b - a));
    const base = median((tallC.length ? tallC : cs).map((c) => c.y1));
    const em = Math.max(1, (base - Math.min(...cs.map((c) => c.y0))) / CAP);
    let run: Run | null = null, prevX = 0;
    for (const c of cs) {
      const m = match(shape(only(c, w), w, c, base, em), t);
      const gap = c.x0 - prevX;
      if (!run || gap > 0.9 * em) { run = { str: m.ch, x: c.x0, base, w: 0, em, dist: 0, capped: 0, chars: 0 }; runs.push(run); }
      // a space is ~0.36 em of ink gap; a narrow "1" leaves ~0.3 em too, so digits never get one ("6.4.110")
      else run.str += (gap > 0.28 * em && !(/[\d.]$/.test(run.str) && /[\d.]/.test(m.ch)) ? " " : "") + m.ch;
      run.w = c.x1 - run.x;
      run.dist += m.d; run.capped += Math.min(0.6, m.d); run.chars++;
      prevX = c.x1;
    }
  }
  for (const r of runs) r.str = r.str.split(" ").map(fixCase).join(" ");
  return runs;
}

/**
 * Look-alikes by context: in a mostly-digit word O/o/l/I are digits, in a capitals word l/0 are I/O, otherwise
 * I/0 are l/o ("OFFICE", "lockers", "C4223"); an O next to a digit is a zero ("MHL2-047").
 */
export function fixCase(w: string): string {
  const n = (re: RegExp) => (w.match(re) ?? []).length;
  const digits = n(/[2-9]/g), upper = n(/[A-HJ-NP-Z]/g), lower = n(/[a-km-np-z]/g);
  if (digits > upper + lower) return w.replace(/[Oo]/g, "0").replace(/[lI]/g, "1");
  if (upper > lower) return w.replace(/l/g, "I").replace(/0/g, "O").replace(/O(?=\d)|(?<=\d)O/g, "0");
  if (lower) return w.replace(/I/g, "l").replace(/0/g, "o");
  return w;
}

let scratch = new Uint8Array(0);
/** Ink image holding only component `c`'s pixels (neighbours poking into its box don't count). */
function only(c: Comp, w: number): Uint8Array {
  const need = c.y1 * w;
  if (scratch.length < need) scratch = new Uint8Array(need);
  for (let y = c.y0; y < c.y1; y++) scratch.fill(0, y * w + c.x0, y * w + c.x1);
  for (const p of c.px) scratch[p] = 1;
  return scratch;
}

/** 8-connected components of the ink. */
function components(ink: Uint8Array, w: number, h: number): Comp[] {
  const seen = new Uint8Array(ink.length), out: Comp[] = [], stack: number[] = [];
  for (let p0 = 0; p0 < ink.length; p0++) {
    if (!ink[p0] || seen[p0]) continue;
    const px: number[] = [];
    seen[p0] = 1; stack.push(p0);
    while (stack.length) {
      const p = stack.pop()!, x = p % w, y = (p / w) | 0;
      px.push(p);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, q = Y * w + X;
        if (X >= 0 && Y >= 0 && X < w && Y < h && ink[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    out.push(bounds(px, w));
  }
  return out;
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };

/** Add pdf.js path data to the context's current path. */
export function tracePath(ctx: CanvasRenderingContext2D, d: Float32Array): void {
  for (let k = 0; k < d.length;) {
    const op = d[k++];
    if (op === 0) { ctx.moveTo(d[k], d[k + 1]); k += 2; }
    else if (op === 1) { ctx.lineTo(d[k], d[k + 1]); k += 2; }
    else if (op === 2) { ctx.bezierCurveTo(d[k], d[k + 1], d[k + 2], d[k + 3], d[k + 4], d[k + 5]); k += 6; }
    else if (op === 3) { ctx.quadraticCurveTo(d[k], d[k + 1], d[k + 2], d[k + 3]); k += 4; }
    else ctx.closePath();
  }
}
