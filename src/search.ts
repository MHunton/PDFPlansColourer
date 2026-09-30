import type { RoomLabel } from "./roomLabels";
import { untracedLabels, type Shape } from "./shapes.ts"; // .ts: also imported by node --test

interface SearchFloor { name: string; shapes: Shape[]; labels?: RoomLabel[] }
export interface Hit<F extends SearchFloor = SearchFloor> { floor: F; shape?: Shape; label?: RoomLabel; text: string }

/**
 * Rooms (and untraced room labels) on any floor whose number, name or notes contain `query`, case-insensitive.
 * Room-number matches first (exact, then prefix), then the rest in floor order.
 */
export function searchRooms<F extends SearchFloor>(floors: F[], query: string, limit = 30): Hit<F>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: (Hit<F> & { rank: number })[] = [];
  const rank = (no = "", ...rest: (string | undefined)[]) => {
    const n = no.toLowerCase();
    if (n === q || n.split(" + ").includes(q)) return 0;
    if (n.startsWith(q)) return 1;
    return n.includes(q) || rest.some((s) => s?.toLowerCase().includes(q)) ? 2 : -1;
  };
  for (const floor of floors) {
    for (const shape of floor.shapes) {
      const r = rank(shape.roomNo, shape.name, shape.notes);
      if (r >= 0) hits.push({ floor, shape, rank: r, text: [shape.roomNo, shape.name].filter(Boolean).join(" ") || "Room (no number)" });
    }
    for (const label of untracedLabels(floor.shapes, floor.labels ?? [])) {
      const r = rank(label.no, label.name);
      if (r >= 0) hits.push({ floor, label, rank: r, text: `${label.no} ${label.name}` });
    }
  }
  return hits.sort((a, b) => a.rank - b.rank).slice(0, limit).map(({ rank: _, ...h }) => h);
}
