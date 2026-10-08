// Door symbols from the drawing's vector lines: a swing arc (chain of short segments round the hinge) and its
// leaf (a line or thin rectangle from the hinge to one arc end). The other arc end is where the closed door sits,
// so hinge -> closed end is the doorway line. Rooms end there; the swing belongs to the room it opens into.
import type { Pt } from "./coords";

export interface Seg { i: number; a: Pt; b: Pt } // i: operator index that drew it
export interface Door { h: Pt; e: Pt }            // hinge, closed-door end (PDF space)

const key = (p: Pt) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt) => Math.hypot(a[0], a[1]);

function circle(p: Pt, q: Pt, r: Pt): { c: Pt; r: number } | null {
  const d = 2 * (p[0] * (q[1] - r[1]) + q[0] * (r[1] - p[1]) + r[0] * (p[1] - q[1]));
  if (Math.abs(d) < 1e-9) return null;
  const s = (v: Pt) => v[0] ** 2 + v[1] ** 2;
  const c: Pt = [(s(p) * (q[1] - r[1]) + s(q) * (r[1] - p[1]) + s(r) * (p[1] - q[1])) / d,
    (s(p) * (r[0] - q[0]) + s(q) * (p[0] - r[0]) + s(r) * (q[0] - p[0])) / d];
  return { c, r: len(sub(p, c)) };
}

/** Doorways within ~6° of the page axes are made exactly horizontal/vertical, so rooms keep square sides. */
function square(d: Door): Door {
  const dx = Math.abs(d.e[0] - d.h[0]), dy = Math.abs(d.e[1] - d.h[1]);
  if (dy < 0.1 * dx) { const y = (d.h[1] + d.e[1]) / 2; return { h: [d.h[0], y], e: [d.e[0], y] }; }
  if (dx < 0.1 * dy) { const x = (d.h[0] + d.e[0]) / 2; return { h: [x, d.h[1]], e: [x, d.e[1]] }; }
  return d;
}

/**
 * Doors among `segs` (thin dark strokes, PDF space). Door widths `minR`..`maxR` (pt). `ops`: operators drawing the
 * arcs and leaves, which aren't walls. Doors whose closed side can't be told (no leaf, or a line at both ends) are
 * skipped: their arcs stay in as barriers.
 */
export function findDoors(segs: Seg[], minR: number, maxR: number): { doors: Door[]; ops: Set<number>; radii: number[] } {
  // Chain short segments that meet end to end (arcs are drawn as separate 2-point paths).
  const short = segs.filter((s) => len(sub(s.b, s.a)) <= 0.5 * maxR);
  const at = new Map<string, number[]>();
  short.forEach((s, j) => { for (const p of [s.a, s.b]) { const k = key(p); at.set(k, [...(at.get(k) ?? []), j]); } });
  const CELL = 2, grid = new Map<string, Seg[]>(); // segments by endpoint cell, for leaf lookups
  const cell = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  for (const sg of segs) for (const p of [sg.a, sg.b]) { const k = cell(p[0], p[1]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(sg); }
  const near = (p: Pt, r: number) => {
    const out = new Set<Seg>();
    for (let x = Math.floor((p[0] - r) / CELL); x <= Math.floor((p[0] + r) / CELL); x++)
      for (let y = Math.floor((p[1] - r) / CELL); y <= Math.floor((p[1] + r) / CELL); y++) for (const sg of grid.get(`${x},${y}`) ?? []) out.add(sg);
    return [...out];
  };
  const used = new Uint8Array(short.length), doors: Door[] = [], ops = new Set<number>();
  const pieces: { c: Pt; r: number; p: Pt[]; idx: number[] }[] = [];
  const other = (j: number, p: Pt): Pt => (key(short[j].a) === key(p) ? short[j].b : short[j].a);

  for (let j0 = 0; j0 < short.length; j0++) {
    if (used[j0]) continue;
    used[j0] = 1;
    // extend both ways while the node joins exactly two segments
    const chain = [j0], pts: Pt[] = [short[j0].a, short[j0].b];
    for (const front of [false, true]) {
      for (;;) {
        const end = front ? pts[0] : pts[pts.length - 1], next = at.get(key(end))!.filter((j) => !used[j]);
        if (next.length !== 1 || at.get(key(end))!.length !== 2) break;
        used[next[0]] = 1;
        const p = other(next[0], end);
        if (front) { pts.unshift(p); chain.unshift(next[0]); } else { pts.push(p); chain.push(next[0]); }
      }
    }
    // runs of steady turning one way (a leaf or frame line joined to the arc breaks the run)
    // turn at vertex k; NaN where the chord length jumps (arcs are drawn in even steps)
    const turn = (k: number) => {
      const u = sub(pts[k], pts[k - 1]), v = sub(pts[k + 1], pts[k]), q = len(v) / len(u);
      return q < 0.6 || q > 1.6 ? NaN : Math.atan2(cross(u, v), dot(u, v));
    };
    const bends = (t: number, sign: number) => Math.abs(t) > 0.02 && Math.abs(t) < 0.7 && Math.sign(t) === sign;
    for (let k = 1; k < pts.length - 1;) {
      const sign = Math.sign(turn(k));
      if (!bends(turn(k), sign)) { k++; continue; }
      let e = k;
      while (e + 1 < pts.length - 1 && bends(turn(e + 1), sign)) e++;
      if (e > k) arc(pts.slice(k - 1, e + 2), chain.slice(k - 1, e + 1)); // 3+ segments
      k = e + 1;
    }
  }

  function arc(p: Pt[], idx: number[]) {
    const f = circle(p[0], p[p.length >> 1], p[p.length - 1]);
    if (!f || f.r < minR || f.r > maxR || p.some((q) => Math.abs(len(sub(q, f.c)) - f.r) > 0.08 * f.r)) return;
    pieces.push({ ...f, p, idx });
  }

  // One swing can be drawn in pieces (gaps where other lines cross it): merge arcs sharing centre and radius.
  const angle = (a: Pt, b: Pt) => Math.abs(Math.atan2(cross(a, b), dot(a, b)));
  const taken = new Uint8Array(pieces.length);
  const swings: { c: Pt; e1: Pt; e2: Pt; tip: Pt; pick: string; leaf: Seg[]; idx: number[]; r: number }[] = [];
  pieces.forEach((a0, n) => {
    if (taken[n]) return;
    // short pieces fit loosely (coordinates are rounded): generous match, then refit on all the points
    const group = pieces.filter((b, m) => !taken[m] && len(sub(b.c, a0.c)) < 0.25 * a0.r && Math.abs(b.r - a0.r) < 0.12 * a0.r && (taken[m] = 1));
    const p = group.flatMap((g) => g.p), idx = group.flatMap((g) => g.idx);
    const byAngle = (c: Pt) => [...p].sort((x, y) => Math.atan2(x[1] - c[1], x[0] - c[0]) - Math.atan2(y[1] - c[1], y[0] - c[0]));
    const q = byAngle(a0.c), f = group.length > 1 ? circle(q[0], q[q.length >> 1], q[q.length - 1]) ?? a0 : a0;
    const c = f.c, r = f.r;
    if (p.some((x) => Math.abs(len(sub(x, c)) - r) > 0.1 * r)) return;
    // angular extent: everything except the largest gap between points round the centre
    const th = p.map((q) => Math.atan2(q[1] - c[1], q[0] - c[0])).sort((x, y) => x - y);
    let gap = th[0] + 2 * Math.PI - th[th.length - 1], at = 0;
    for (let k = 1; k < th.length; k++) if (th[k] - th[k - 1] > gap) { gap = th[k] - th[k - 1]; at = k; }
    const sweep = 2 * Math.PI - gap, t1 = th[at], t2 = th[(at + th.length - 1) % th.length];
    const e1: Pt = [c[0] + r * Math.cos(t1), c[1] + r * Math.sin(t1)], e2: Pt = [c[0] + r * Math.cos(t2), c[1] + r * Math.sin(t2)];
    const u = sub(e1, c), v = sub(e2, c);
    if (sweep < 1.1 || sweep > 3.5) return;
    // leaf: a straight line (or thin rectangle's sides) from the hinge out to about the radius, within the swing
    const out = (s: Seg) => (len(sub(s.a, c)) > len(sub(s.b, c)) ? sub(s.a, c) : sub(s.b, c));
    const leaf = near(c, 0.15 * r).filter((s) => [[s.a, s.b], [s.b, s.a]].some(([x, y]) => len(sub(x, c)) < 0.15 * r && Math.abs(len(sub(y, c)) - r) < 0.15 * r)
      && angle(out(s), u) < sweep + 0.2 && angle(out(s), v) < sweep + 0.2);
    // closed door is square to the open leaf; a leaf half way round a ~180° swing is a double-acting door drawn
    // closed (doorway: hinge to leaf tip). Lines vote (a thin-rectangle leaf has two sides): a lone threshold line can't outvote it.
    const votes = new Map<string, number>();
    for (const s of leaf) {
      const offU = Math.abs(angle(out(s), u) - Math.PI / 2), offV = Math.abs(angle(out(s), v) - Math.PI / 2);
      const pick = sweep > 2.6 && Math.abs(offU - offV) < 0.35 ? "both" : Math.min(offU, offV) >= 0.35 ? "" : offU < offV ? "u" : "v";
      if (pick) votes.set(pick, (votes.get(pick) ?? 0) + 1);
    }
    const ranked = [...votes].sort((x, y) => y[1] - x[1]);
    const pick = !ranked.length || ranked[1]?.[1] === ranked[0][1] ? "" : ranked[0][0];
    const l = leaf.find((s) => Math.abs(angle(out(s), u) - angle(out(s), v)) < 0.35), tip: Pt = l ? [c[0] + out(l)[0], c[1] + out(l)[1]] : e1;
    swings.push({ c, e1, e2, tip, pick, leaf, idx, r });
  });

  // An operator can draw more than the door (a leaf drawn as part of the wall outline): only door-sized ones go.
  const opLen = new Map<number, number>();
  for (const s of segs) opLen.set(s.i, (opLen.get(s.i) ?? 0) + len(sub(s.b, s.a)));
  for (const { c, e1, e2, tip, pick, leaf, idx, r } of swings) {
    if (!pick) continue;
    doors.push(square({ h: c, e: pick === "both" ? tip : pick === "u" ? e1 : e2 }));
    for (const i of [...idx.map((j) => short[j].i), ...leaf.map((s) => s.i)]) if (opLen.get(i)! <= 3.3 * r) ops.add(i);
  }
  return { doors, ops, radii: swings.filter((s) => s.leaf.length).map((s) => s.r) }; // radii: swings with a leaf (real doors)
}
