import type { Pt } from "./coords";

/**
 * A marked room. Points are PDF user-space coordinates of the floor's page (see coords.ts).
 * `roomNo`/`name` come from the drawing text when the room was detected automatically.
 */
export interface Shape { id: string; points: Pt[]; roomNo?: string; name?: string; notes?: string; categoryId?: string }

/** A colour-key entry (lighting type). Project-wide: shared by all floors. */
export interface Category { id: string; name: string; colour: string }

export const newId = () => Math.random().toString(36).slice(2, 10);

const LIMIT = 200;

/**
 * Per-floor undo/redo by snapshot: before each edit, push a copy of the floor's whole shape list.
 * ponytail: snapshots copy every shape on the floor (fine for hundreds of rooms); switch to diffs if floors get huge.
 */
export class History<F extends { shapes: Shape[] }> {
  private stacks = new WeakMap<F, { undo: Shape[][]; redo: Shape[][] }>();

  private get(floor: F) {
    let s = this.stacks.get(floor);
    if (!s) this.stacks.set(floor, (s = { undo: [], redo: [] }));
    return s;
  }

  /** Record `before` (a snapshot taken with `snapshot()` before mutating `floor.shapes`). */
  push(floor: F, before: Shape[]): void {
    const s = this.get(floor);
    s.undo.push(before);
    if (s.undo.length > LIMIT) s.undo.shift();
    s.redo = [];
  }

  undo(floor: F): boolean { return this.step(floor, "undo", "redo"); }
  redo(floor: F): boolean { return this.step(floor, "redo", "undo"); }
  canUndo(floor: F): boolean { return this.get(floor).undo.length > 0; }
  canRedo(floor: F): boolean { return this.get(floor).redo.length > 0; }

  private step(floor: F, from: "undo" | "redo", to: "undo" | "redo"): boolean {
    const s = this.get(floor);
    const shapes = s[from].pop();
    if (!shapes) return false;
    s[to].push(snapshot(floor.shapes));
    floor.shapes = shapes;
    return true;
  }
}

export const snapshot = (shapes: Shape[]): Shape[] => structuredClone(shapes);

/** Shoelace area (absolute). */
export function polygonArea(pts: Pt[]): number {
  let s = 0;
  pts.forEach(([x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; s += x * y2 - x2 * y; });
  return Math.abs(s) / 2;
}

/** Even-odd ray casting. */
export function pointInPolygon([x, y]: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Index i of the edge (pts[i] -> pts[i+1]) nearest to p, the closest point on it, and the distance. */
export function nearestEdge(p: Pt, pts: Pt[]): { i: number; at: Pt; dist: number } {
  let best = { i: 0, at: pts[0], dist: Infinity };
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const at: Pt = [a[0] + t * dx, a[1] + t * dy], dist = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (dist < best.dist) best = { i, at, dist };
  });
  return best;
}

/**
 * Room labels not yet placed: no room carries the number, and no room contains the label (e.g. a room drawn by
 * hand around an open-plan area, or corners dragged over the marker).
 */
export function untracedLabels<L extends { no: string; at: Pt }>(shapes: Shape[], labels: L[]): L[] {
  const numbers = new Set(shapes.flatMap((s) => s.roomNo?.split(" + ") ?? []));
  return labels.filter((l) => !numbers.has(l.no) && !shapes.some((s) => pointInPolygon(l.at, s.points)));
}
