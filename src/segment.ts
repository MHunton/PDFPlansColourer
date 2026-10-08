// Room segmentation on barrier rasters (1 = wall/line, 0 = open floor). Pure functions; runs in a worker.
//
// Two barrier images of the same page, plus doorway lines found from door symbols (drawn into both):
//   walls - thick lines only. Openings without a door symbol are gaps; bridge() closes them along the wall line
//           (2.2 m, then 3.3 m where needed), so rooms end at their walls and doors, and a door swing belongs to
//           the room it opens into.
//   lines - walls + thin dark lines (glazing, undetected door arcs). Used where the walls version fails.
// Conservative: a room is only returned if one version gives it a closed space holding no other label. Shared
// spaces (open plan, rooms joined by an opening wider than a door) are left for the user to draw.

export interface SegmentInput {
  w: number; h: number;
  walls: Uint8Array; lines: Uint8Array;
  seeds: Float32Array;  // x0,y0,x1,y1,... pixel coords of room labels
  alt?: Float32Array;   // same layout: a second seed per label (its name), NaN if none
  doors?: Float32Array; // hx,hy,ex,ey,... doorway lines found from door symbols (hinge to closed end), pixels
  closeR: number;       // px, half the widest door to bridge
  sealR: number;        // px, half the widest external opening (entrances); seals the building to find "outside"
  minArea: number; maxArea: number; // px²
}
/** One room: the label seed it belongs to and its outline (flat x,y pixel coords). */
export interface Room { seeds: number[]; points: number[] }

interface Region { area: number; x0: number; y0: number; x1: number; y1: number; bad: boolean }
type Pass = ReturnType<typeof fillAll>;

export function segment(inp: SegmentInput): Room[] {
  const { w, h, seeds, minArea, maxArea } = inp;
  if (inp.doors) for (const m of [inp.walls, inp.lines]) doorLines(m, w, h, inp.doors);
  const reach = Math.max(3, Math.round(inp.closeR / 2)); // lines version: how far from a label's centre to look for open floor
  // Outside the building is off-limits, or a corridor escapes through its entrance doors into the site around it.
  // Sealed on the lines version: some wings draw their walls as thin as detail lines, so the walls version alone
  // would leave them open to the outside.
  const out = outside(close(inp.lines, w, h, inp.sealR), w, h);
  // Walls version: label must sit on open floor (2px slack). If the closing filled its spot, the space is narrower
  // than a door and searching further could hop over a door line into the neighbour: leave it to the lines version.
  // closeR ~0.55 m: openings up to 4*closeR (~2.2 m), wall ends up to closeR thick. Where that leaves a label sharing
  // its space, openings up to 6*closeR (~3.3 m: wide double doors, part-height partitions). Wider first would cut
  // rooms along furniture lines and chop corridors; doors drawn with a swing are closed exactly anyway (doorLines).
  // close(3px) first: walls drawn as two outlines (hatch between) become solid, so wall lengths are measurable.
  const solid = close(inp.walls, w, h, 3), wall = Math.round(inp.closeR * 0.7), run = Math.round(inp.closeR * 1.2);
  const bridged = bridge(solid, w, h, 4 * inp.closeR, wall, run);
  const maskA = or(bridged.slice(), out), a = fillAll(maskA, w, h, seeds, maxArea, 2, inp.alt);
  adopt(a, maskA, bridged, solid, w, h, wall + 2, 25 * (inp.closeR / 0.55) ** 2);
  const a2 = fillAll(or(bridge(solid, w, h, 6 * inp.closeR, wall, run), out), w, h, seeds, maxArea, 2, inp.alt);
  const b = fillAll(or(dilate(inp.lines, w, h, 1), out), w, h, seeds, maxArea, reach, inp.alt); // 1px: seal hairline drafting gaps
  // Wide-door version: gaps up to ~4*closeR bridged (double doors). Too coarse to trace from (it fills narrow rooms),
  // but it bounds a lines-version room: growing into it restores the door-swing areas the arcs cut out.
  const growR = 2 * inp.closeR;
  const c = fillAll(or(close(inp.walls, w, h, growR), out), w, h, seeds, maxArea, 2);

  const ok = (r: Region | undefined) => !!r && !r.bad && r.area >= minArea;
  const labelsIn = (pass: Pass) => { const c = new Map<number, number>(); for (const id of pass.seedRegion) c.set(id, (c.get(id) ?? 0) + 1); return c; };
  const ca = labelsIn(a), ca2 = labelsIn(a2), cb = labelsIn(b), cc = labelsIn(c);
  const own = (pass: Pass, counts: Map<number, number>, k: number) => {
    const id = pass.seedRegion[k];
    return ok(pass.info[id]) && counts.get(id) === 1 ? pass.info[id] : null;
  };
  // Walls version (rooms end at wall lines and doorways); lines version only where that gives no room of its own.
  const parts: { pass: Pass; id: number; k: number; grow?: Grow }[] = [];
  for (let k = 0; k < seeds.length / 2; k++) {
    const pa = own(a, ca, k) ? a : own(a2, ca2, k) ? a2 : null, B = own(b, cb, k);
    if (pa) parts.push({ pass: pa, id: pa.seedRegion[k], k });
    else if (B) {
      const grow = own(c, cc, k) ? { regions: c.regions, id: c.seedRegion[k], dist: growR } : undefined;
      parts.push({ pass: b, id: b.seedRegion[k], k, grow });
    }
  }
  // Smallest first, each claiming its floor: rooms taken from the two versions can't overlap.
  parts.sort((p, q) => p.pass.info[p.id].area - q.pass.info[q.id].area);
  const claimed = new Uint8Array(w * h), rooms: Room[] = [];
  for (const { pass, id, k, grow } of parts) {
    const points = trace(pass.regions, w, h, pass.info[id], id, claimed, seeds[2 * k], seeds[2 * k + 1], Math.round(0.7 * inp.closeR), grow);
    if (points.length >= 6) rooms.push({ seeds: [k], points });
  }
  return rooms;
}

/** Draw each doorway as a 3px barrier, 2px past both ends so it meets the jambs. */
function doorLines(m: Uint8Array, w: number, h: number, d: Float32Array) {
  for (let k = 0; k < d.length; k += 4) {
    const L = Math.hypot(d[k + 2] - d[k], d[k + 3] - d[k + 1]) || 1, ux = (d[k + 2] - d[k]) / L, uy = (d[k + 3] - d[k + 1]) / L;
    for (let t = -2; t <= L + 2; t += 0.5) {
      const x = Math.round(d[k] + ux * t), y = Math.round(d[k + 1] + uy * t);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h) m[(y + dy) * w + x + dx] = 1;
    }
  }
}

/**
 * A bridged opening can cut the end off a corridor or room, leaving a piece with no label (nobody traces it). Such
 * a piece joins the labelled region it shares the most bridged opening with, if it's small (<= maxArea and no
 * bigger than that region) and that neighbour clearly dominates. `reach`: widest bridge band to look across.
 */
function adopt(pass: Pass, mask: Uint8Array, bridged: Uint8Array, solid: Uint8Array, w: number, h: number, reach: number, maxArea: number) {
  const { regions, info, seedRegion } = pass, labels = new Map<number, number>();
  for (const id of seedRegion) labels.set(id, (labels.get(id) ?? 0) + 1);
  for (let p = 0; p < w * h; p++) if (!mask[p] && !regions[p]) info.push(flood(mask, regions, w, h, p, info.length, maxArea)); // unlabelled spaces
  const touch = new Map<number, Map<number, number[]>>(); // orphan -> neighbour -> bridge pixels between them
  for (let p = 0; p < w * h; p++) {
    if (!bridged[p] || solid[p]) continue;
    for (const d of [1, w]) { // across the band: row and column
      const side = (dir: number) => { let q = p; for (let k = 0; k <= reach; k++) { q += dir; if (q < 0 || q >= w * h) return 0; if (!bridged[q]) return regions[q]; } return 0; };
      const r1 = side(-d), r2 = side(d);
      if (!r1 || !r2 || r1 === r2) continue;
      for (const [o, n] of [[r1, r2], [r2, r1]]) {
        if (labels.has(o) || labels.get(n) !== 1 || info[o].bad || info[n].bad || info[o].area > maxArea || info[o].area > info[n].area) continue;
        const m = touch.get(o) ?? touch.set(o, new Map()).get(o)!;
        (m.get(n) ?? m.set(n, []).get(n)!).push(p);
      }
    }
  }
  const to = new Map<number, number>();
  for (const [o, m] of touch) {
    const [best, second] = [...m].sort((x, y) => y[1].length - x[1].length);
    if (second && second[1].length * 2 > best[1].length) continue; // no clear owner
    const [n, band] = best, r = info[n], q = info[o];
    to.set(o, n);
    for (const p of band) regions[p] = n;
    r.area += q.area + band.length;
    r.x0 = Math.min(r.x0, q.x0); r.y0 = Math.min(r.y0, q.y0); r.x1 = Math.max(r.x1, q.x1); r.y1 = Math.max(r.y1, q.y1);
  }
  if (to.size) for (let p = 0; p < w * h; p++) { const n = to.get(regions[p]); if (n) regions[p] = n; }
}

// ---- morphology (square structuring element, separable running counts: O(pixels) for any radius) ----

export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) { // horizontal
    const row = y * w;
    let c = 0;
    for (let x = 0; x < Math.min(r, w); x++) c += m[row + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) c += m[row + x + r];
      if (x - r - 1 >= 0) c -= m[row + x - r - 1];
      tmp[row + x] = c > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) { // vertical
    let c = 0;
    for (let y = 0; y < Math.min(r, h); y++) c += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) c += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) c -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = c > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Close doorways: a gap of up to `maxGap` px along a row (or column) between two wall pixels, where at least one
 * side is a wall *end*: a wall no thicker than `maxWall` across the gap that continues along it for at least
 * `minRun` and twice its thickness (a jamb: long and thin). That rules out narrow rooms (their sides are long walls
 * across the gap), and door-frame nibs and wall-mounted symbols such as call points (short, blocky stubs off a
 * wall), which would otherwise throw a false wall across the room.
 */
export function bridge(m: Uint8Array, w: number, h: number, maxGap: number, maxWall: number, minRun: number): Uint8Array {
  const out = m.slice(), vRun = new Int32Array(w * h), hRun = new Int32Array(w * h); // wall run length through each pixel
  for (let x = 0; x < w; x++) for (let y = 0; y < h;) {
    let j = y;
    while (j < h && m[j * w + x] === m[y * w + x]) j++;
    if (m[y * w + x]) for (let k = y; k < j; k++) vRun[k * w + x] = j - y;
    y = j;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w;) {
    let j = x;
    while (j < w && m[y * w + j] === m[y * w + x]) j++;
    if (m[y * w + x]) hRun.fill(j - x, y * w + x, y * w + j);
    x = j;
  }
  // along a row: wall thickness is its vertical run, its continuation the horizontal run (and vice versa)
  const jamb = (p: number, across: Int32Array, along: Int32Array) => across[p] <= maxWall && along[p] >= Math.max(minRun, 2 * across[p]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w;) {
    let j = x;
    while (j < w && !m[y * w + j]) j++;
    if (j > x && x > 0 && j < w && j - x <= maxGap && (jamb(y * w + x - 1, vRun, hRun) || jamb(y * w + j, vRun, hRun))) out.fill(1, y * w + x, y * w + j);
    x = Math.max(j, x + 1);
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h;) {
    let j = y;
    while (j < h && !m[j * w + x]) j++;
    if (j > y && y > 0 && j < h && j - y <= maxGap && (jamb((y - 1) * w + x, hRun, vRun) || jamb(j * w + x, hRun, vRun))) for (let k = y; k < j; k++) out[k * w + x] = 1;
    y = Math.max(j, y + 1);
  }
  return out;
}

const invert = (m: Uint8Array) => { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ^ 1; return o; };
/** Closing: bridges gaps narrower than 2r+1 without growing walls elsewhere. */
export const close = (m: Uint8Array, w: number, h: number, r: number) => invert(dilate(invert(dilate(m, w, h, r)), w, h, r));

const or = (m: Uint8Array, o: Uint8Array) => { for (let i = 0; i < m.length; i++) m[i] |= o[i]; return m; };

/**
 * Outside the building: in the sealed image (entrances closed), the largest connected open area plus anything
 * touching the image edge. The drawing frame encloses everything, so "reachable from the edge" alone isn't it;
 * the space around the building is bigger than any room.
 */
function outside(mask: Uint8Array, w: number, h: number): Uint8Array {
  const regions = new Int32Array(w * h), info: Region[] = [{ area: 0, x0: 0, y0: 0, x1: 0, y1: 0, bad: false }];
  for (let p = 0; p < w * h; p++) if (!mask[p] && !regions[p]) info.push(flood(mask, regions, w, h, p, info.length, Infinity));
  let big = 0;
  info.forEach((r, id) => { if (r.area > info[big].area) big = id; });
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (regions[p] && (regions[p] === big || info[regions[p]].bad)) out[p] = 1;
  return out;
}

// ---- flood fill from every seed ----

function fillAll(mask: Uint8Array, w: number, h: number, seeds: Float32Array, maxArea: number, reach: number, alt?: Float32Array) {
  const regions = new Int32Array(w * h); // 0 = unassigned
  const info: Region[] = [{ area: 0, x0: 0, y0: 0, x1: 0, y1: 0, bad: true }];
  const seedRegion = new Int32Array(seeds.length / 2);
  for (let k = 0; k < seedRegion.length; k++) {
    const p = nearFree(mask, w, h, Math.round(seeds[2 * k]), Math.round(seeds[2 * k + 1]), reach);
    if (p < 0) continue;
    if (regions[p]) { seedRegion[k] = regions[p]; continue; }
    const id = info.length;
    info.push(flood(mask, regions, w, h, p, id, maxArea));
    seedRegion[k] = id;
  }
  // A label whose number shares a space (or sits on a wall) moves to its name's space, if no other label is there.
  if (alt) {
    const count = new Map<number, number>();
    for (const id of seedRegion) if (id) count.set(id, (count.get(id) ?? 0) + 1);
    for (let k = 0; k < seedRegion.length; k++) {
      const id = seedRegion[k];
      if ((id && count.get(id)! < 2) || Number.isNaN(alt[2 * k])) continue;
      const p = nearFree(mask, w, h, Math.round(alt[2 * k]), Math.round(alt[2 * k + 1]), reach);
      if (p < 0) continue;
      let to = regions[p];
      if (!to) { to = info.length; info.push(flood(mask, regions, w, h, p, to, maxArea)); }
      if (to === id || count.get(to)) continue;
      if (id) count.set(id, count.get(id)! - 1);
      seedRegion[k] = to;
      count.set(to, 1);
    }
  }
  return { regions, info, seedRegion };
}

/** Seed pixel, or the nearest open pixel within `reach` px (labels sometimes sit on a line). -1 if none. */
function nearFree(mask: Uint8Array, w: number, h: number, x: number, y: number, reach: number): number {
  for (let r = 0; r <= reach; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < w && Y < h && !mask[Y * w + X]) return Y * w + X;
    }
  }
  return -1;
}

/** 4-connected scanline fill. Marks region bad if it exceeds maxArea or touches the image edge (leaked outside). */
let stack = new Int32Array(1 << 16); // shared by flood(); grows as needed

function flood(mask: Uint8Array, regions: Int32Array, w: number, h: number, p: number, id: number, maxArea: number): Region {
  const r: Region = { area: 0, x0: w, y0: h, x1: 0, y1: 0, bad: false };
  const free = (i: number) => !mask[i] && !regions[i];
  let sp = 0;
  stack[sp++] = p;
  while (sp) {
    const q = stack[--sp];
    if (!free(q)) continue;
    const y = (q / w) | 0, row = y * w;
    let l = q - row, rr = l;
    while (l > 0 && free(row + l - 1)) l--;
    while (rr < w - 1 && free(row + rr + 1)) rr++;
    regions.fill(id, row + l, row + rr + 1);
    r.area += rr - l + 1;
    if (l < r.x0) r.x0 = l; if (rr > r.x1) r.x1 = rr; if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y;
    if (l === 0 || rr === w - 1 || y === 0 || y === h - 1) r.bad = true;
    if (r.area > maxArea) { r.bad = true; break; }
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      for (let x = l; x <= rr; x++) {
        if (free(nrow + x) && (x === l || !free(nrow + x - 1))) {
          if (sp === stack.length) { const bigger = new Int32Array(stack.length * 2); bigger.set(stack); stack = bigger; }
          stack[sp++] = nrow + x;
        }
      }
    }
  }
  return r;
}

// ---- outline ----

const DX = [-1, -1, 0, 1, 1, 1, 0, -1], DY = [0, -1, -1, -1, 0, 1, 1, 1]; // clockwise from west (y down)

/** Extra floor a room may take: region `id` of `regions`, within `dist` px of the room. */
interface Grow { regions: Int32Array; id: number; dist: number }

/**
 * Outline of the part of region `id` that holds the label at (sx, sy), minus floor already claimed by smaller
 * rooms, grown into `grow` if given; holes (furniture, text) filled unless claimed. Claims the result.
 * Simplified, flat pixel-centre coords.
 * ponytail: a room fully inside another is a hole in it, but shapes have no holes: the outer one's outline still
 * covers the inner room (drawn underneath it). Add polygon holes if nested rooms turn out common.
 */
function trace(regions: Int32Array, w: number, h: number, r: Region, id: number, claimed: Uint8Array, sx: number, sy: number, notch: number, grow?: Grow): number[] {
  // Work window: the region's box (+ growth distance, + room for the notch closing), with a 1px padding ring.
  const pad = Math.max(grow?.dist ?? 0, notch + 1);
  const X0 = Math.max(0, r.x0 - pad), Y0 = Math.max(0, r.y0 - pad), X1 = Math.min(w - 1, r.x1 + pad), Y1 = Math.min(h - 1, r.y1 + pad);
  const lw = X1 - X0 + 3, lh = Y1 - Y0 + 3, n = lw * lh;
  const g = (i: number) => (((i / lw) | 0) - 1 + Y0) * w + (i % lw) - 1 + X0; // interior cells only
  const own = new Uint8Array(n);
  for (let y = 1; y < lh - 1; y++) for (let x = 1; x < lw - 1; x++) { const p = (y - 1 + Y0) * w + x - 1 + X0; if (regions[p] === id && !claimed[p]) own[y * lw + x] = 1; }

  // Start from the own pixel nearest the label (claims can cut a region into pieces; keep the labelled one).
  const lx = Math.min(lw - 2, Math.max(1, Math.round(sx) - X0 + 1)), ly = Math.min(lh - 2, Math.max(1, Math.round(sy) - Y0 + 1));
  let start = -1;
  for (let rad = 0; start < 0 && rad < Math.max(lw, lh); rad++) {
    for (let y = ly - rad; start < 0 && y <= ly + rad; y++) for (let x = lx - rad; x <= lx + rad; x++) {
      if ((Math.abs(y - ly) === rad || Math.abs(x - lx) === rad) && x > 0 && y > 0 && x < lw - 1 && y < lh - 1 && own[y * lw + x]) { start = y * lw + x; break; }
    }
  }
  if (start < 0) return [];
  const N4 = [-1, 1, -lw, lw];
  const comp = new Uint8Array(n), stack = [start];
  comp[start] = 1;
  while (stack.length) { const i = stack.pop()!; for (const d of N4) { const j = i + d; if (own[j] && !comp[j]) { comp[j] = 1; stack.push(j); } } }
  if (grow) { // breadth-first into the wide-door region, up to grow.dist px from the room
    const dist = new Int32Array(n).fill(-1), queue: number[] = [];
    for (let i = 0; i < n; i++) if (comp[i]) { dist[i] = 0; queue.push(i); }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      if (dist[i] >= grow.dist) continue;
      for (const d of N4) {
        const j = i + d, x = j % lw, y = (j / lw) | 0;
        if (dist[j] >= 0 || x < 1 || y < 1 || x >= lw - 1 || y >= lh - 1) continue;
        const p = g(j);
        if (grow.regions[p] !== grow.id || claimed[p]) continue;
        dist[j] = dist[i] + 1; comp[j] = 1; queue.push(j);
      }
    }
  }
  // Holes: not reachable from the padding without crossing the room.
  const out = new Uint8Array(n);
  out[0] = 1; stack.push(0);
  while (stack.length) {
    const i = stack.pop()!, x = i % lw, y = (i / lw) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      const j = ny * lw + nx;
      if (nx >= 0 && ny >= 0 && nx < lw && ny < lh && !out[j] && !comp[j]) { out[j] = 1; stack.push(j); }
    }
  }
  for (let i = 0; i < n; i++) if (!comp[i] && !out[i] && !claimed[g(i)]) comp[i] = 1;
  // Small intrusions (wall-mounted boxes, door-frame nibs, call points) up to 2*notch wide: part of the room.
  const shut = close(comp, lw, lh, notch);
  for (let i = 0; i < n; i++) if (shut[i] && !comp[i] && !claimed[g(i)] && i % lw && i % lw < lw - 1 && i >= lw && i < n - lw) comp[i] = 1;
  const keep = new Uint8Array(n); // only what stays joined to the room (claims can cut off bits of the closing)
  keep[start] = 1; stack.push(start);
  while (stack.length) { const i = stack.pop()!; for (const d of N4) { const j = i + d; if (comp[j] && !keep[j]) { keep[j] = 1; stack.push(j); } } }
  comp.set(keep);
  for (let i = 0; i < n; i++) if (comp[i]) claimed[g(i)] = 1;
  return squareUp(simplify(moore(comp, lw, lh, X0 - 1, Y0 - 1), 2)); // eps ~1.4 pt at A0 detection resolution
}

/** Moore-neighbour trace of the outer boundary of a padded mask; (ox, oy) = global position of mask cell 0. */
function moore(inside: Uint8Array, lw: number, lh: number, ox: number, oy: number): number[] {
  const start = inside.indexOf(1); // first in scan order: its west neighbour is outside
  if (start < 0) return [];
  const pts: number[] = [];
  let cx = start % lw, cy = (start / lw) | 0, back = 0;
  const sx = cx, sy = cy;
  for (let guard = 0; guard < 4 * lw * lh; guard++) {
    pts.push(cx + ox + 0.5, cy + oy + 0.5);
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8, nx = cx + DX[d], ny = cy + DY[d];
      if (inside[ny * lw + nx]) {
        const b = (d + 7) % 8, bx = cx + DX[b] - nx, by = cy + DY[b] - ny; // backtrack pixel, relative to new pixel
        cx = nx; cy = ny;
        back = DX.findIndex((v, i) => v === bx && DY[i] === by);
        moved = true;
        break;
      }
    }
    if (!moved || (cx === sx && cy === sy)) break;
  }
  return pts;
}

/**
 * Snap edges within 3 px (and 1:10) of horizontal/vertical onto the axis, at their mean line. Simplifying turns
 * small steps (a wall face next to a bridged doorway) into long slants; rooms are drawn square.
 */
export function squareUp(p: number[]): number[] {
  const n = p.length / 2, q = p.slice();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, dx = q[2 * j] - q[2 * i], dy = q[2 * j + 1] - q[2 * i + 1];
    for (const [a, d, o] of [[1, dy, dx], [0, dx, dy]]) { // a = axis to equalise (y for near-horizontal)
      if (Math.abs(d) > 0 && Math.abs(d) <= 3 && Math.abs(d) <= 0.1 * Math.abs(o)) q[2 * i + a] = q[2 * j + a] = (q[2 * i + a] + q[2 * j + a]) / 2;
    }
  }
  const out: number[] = []; // drop repeated and collinear corners
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = (i + 1) % n;
    const cr = (q[2 * i] - q[2 * a]) * (q[2 * b + 1] - q[2 * i + 1]) - (q[2 * i + 1] - q[2 * a + 1]) * (q[2 * b] - q[2 * i]);
    if (Math.abs(cr) > 1e-6) out.push(q[2 * i], q[2 * i + 1]);
  }
  return out.length >= 6 ? out : q;
}

/** Douglas-Peucker on a closed ring (flat coords). */
export function simplify(p: number[], eps: number): number[] {
  const n = p.length / 2;
  if (n < 4) return p;
  // split the ring at point 0 and the point farthest from it
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) { const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2; if (d > best) { best = d; far = i; } }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const dp = (i: number, j: number) => { // j may wrap to n (= point 0)
    let idx = -1, max = eps;
    const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * (j % n)], by = p[2 * (j % n) + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - p[2 * k + 1]) - (ax - p[2 * k]) * (by - ay)) / len;
      if (d > max) { max = d; idx = k; }
    }
    if (idx >= 0) { keep[idx] = 1; dp(i, idx); dp(idx, j); }
  };
  dp(0, far);
  dp(far, n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}
