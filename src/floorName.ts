// Floor naming: guess a floor name from drawing text / file name, and rank names so floors sort bottom to top.

const ORDINALS = ["ground", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const FLOOR_RE = new RegExp(
  String.raw`\b(basement|lower ground|upper ground|mezzanine|${ORDINALS.join("|")}|\d+(?:st|nd|rd|th))\s+floor\b` +
  String.raw`|\blevel\s+(-?\d+|[a-z])\b|\b(roof)\s+plan\b`,
  "gi",
);

/** Most frequent floor phrase in the drawing text, else in the file name (also "L4" there), else "". */
export function guessFloorName(pageText: string, fileName = ""): string {
  for (const text of [pageText, fileName.replace(/\.pdf$/i, "").replace(/[_.-]+/g, " ")]) {
    const counts = new Map<string, number>();
    for (const m of text.matchAll(FLOOR_RE)) {
      const name = m[1] ? `${cap(m[1].toLowerCase())} floor` : m[2] ? `Level ${m[2].toUpperCase()}` : "Roof";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if (counts.size) return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }
  const short = fileName.match(/(?:^|[\s_.-])L(\d{1,2})(?=$|[\s_.-])/i); // "Phase 2 L4.pdf"
  return short ? `Level ${Number(short[1])}` : "";
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Sort key, lowest floor first. Unrecognised names sort last (stable sort keeps their order). */
export function floorRank(name: string): number {
  const s = name.toLowerCase();
  let m = s.match(/\blevel\s*(-?\d+)\b/) ?? s.match(/\b(\d+)(?:st|nd|rd|th)\s+floor\b/);
  if (m) return Number(m[1]);
  if (s.includes("basement")) return -1;
  if (s.includes("lower ground")) return -0.5;
  if (s.includes("upper ground")) return 0.5;
  if (s.includes("mezzanine")) return 0.6;
  if (s.includes("roof")) return 1000;
  m = s.match(new RegExp(String.raw`\b(${ORDINALS.join("|")})\b`));
  return m ? ORDINALS.indexOf(m[1]) : 1e9;
}
