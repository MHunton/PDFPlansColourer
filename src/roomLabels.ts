import type { Pt } from "./coords";

/** pdf.js text item (subset). transform is in PDF user space. */
export interface TextItem { str: string; transform: number[]; width: number; height: number }
/** `at`: centre of the number; `nameAt`: centre of the name (a second seed: labels sometimes straddle a wall). */
export interface RoomLabel { no: string; name: string; at: Pt; nameAt?: Pt }

const sig = (s: string) => s.replace(/\d/g, "9").replace(/[a-z]/gi, "A");

/**
 * Room labels: text items matching the drawing's dominant room-number pattern (e.g. "9.9.999" for "4.3.030"),
 * each with the name printed just below it (or above). `at` is the centre of the number, in PDF space.
 * ponytail: pattern-based; drawings whose rooms have names but no numbers get no labels (draw those by hand).
 */
export function roomLabels(items: TextItem[]): RoomLabel[] {
  const tokens = items.filter((it) => /^\S{2,12}$/.test(it.str.trim()) && /\d/.test(it.str));
  const counts = new Map<string, number>();
  for (const it of tokens) { const s = sig(it.str.trim()); counts.set(s, (counts.get(s) ?? 0) + 1); }
  // Plain numbers ("2400") are usually dimensions: prefer patterns with a letter or separator.
  const score = ([s, c]: [string, number]) => (/^9+$/.test(s) ? c / 2 : c);
  const best = [...counts].sort((a, b) => score(b) - score(a))[0];
  if (!best || best[1] < 3) return [];
  const isNo = (it: TextItem) => { const s = sig(it.str.trim()); return s === best[0] || s === best[0] + "A"; };

  const numbers = tokens.filter(isNo);
  // Name candidates: not a room number, and not a code/tag like "FES.Z4.L3.13" (digits, no spaces).
  const others = items.filter((it) => it.str.trim() && !isNo(it) && !/^\S*\d\S*$/.test(it.str.trim()));
  return numbers.map((it) => { const n = nameFor(it, others); return { no: it.str.trim(), name: n?.str.trim() ?? "", at: centre(it), nameAt: n && centre(n) }; });
}

function frame(it: TextItem) {
  const [a, b, c, d] = it.transform, n1 = Math.hypot(a, b) || 1, n2 = Math.hypot(c, d) || 1;
  return { dir: [a / n1, b / n1] as Pt, up: [c / n2, d / n2] as Pt };
}

function centre(it: TextItem): Pt {
  const { dir, up } = frame(it), [, , , , e, f] = it.transform;
  return [e + (dir[0] * it.width) / 2 + (up[0] * it.height) / 2, f + (dir[1] * it.width) / 2 + (up[1] * it.height) / 2];
}

/** Nearest same-orientation text line directly below the number (else above), within ~3 line heights. */
function nameFor(no: TextItem, others: TextItem[]): TextItem | undefined {
  const { dir, up } = frame(no), c = centre(no), h = no.height || 1;
  let best: { d: number; it: TextItem } | null = null;
  for (const it of others) {
    const f = frame(it);
    if (f.dir[0] * dir[0] + f.dir[1] * dir[1] < 0.9) continue; // different orientation
    const p = centre(it), dx = p[0] - c[0], dy = p[1] - c[1];
    const along = dx * dir[0] + dy * dir[1], across = dx * up[0] + dy * up[1]; // across < 0 = below
    if (Math.abs(along) > (no.width + it.width) / 2 + h || Math.abs(across) > 3 * h || Math.abs(across) < 0.3 * h) continue;
    const d = across < 0 ? -across : 10 * h + across; // prefer below
    if (!best || d < best.d) best = { d, it };
  }
  return best?.it;
}

/** Drawing scale from text like "1 : 200" (most frequent), or null. */
export function drawingScale(text: string): number | null {
  const counts = new Map<number, number>();
  for (const m of text.matchAll(/\b1\s*:\s*(\d{1,4})\b/g)) {
    const n = Number(m[1]);
    if (n >= 10) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
