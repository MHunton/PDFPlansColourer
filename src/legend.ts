// Colour key box drawn on each floor. Lives in view space (pt, y down, page rotation applied), i.e. upright the
// way the user sees the plan. Laid out by one pure function for both the SVG overlay and the PDF export.

/** Top-left corner and text size, in view pt. */
export interface LegendState { x: number; y: number; size: number }
export interface LegendItem { name: string; colour: string }
type Measure = (text: string, size: number, bold: boolean) => number;

export const LEGEND_TITLE = "Lighting key";

/** Positions relative to the legend's top-left; `y` of texts is the baseline. */
export function legendLayout(items: LegendItem[], size: number, measure: Measure) {
  const pad = 0.7 * size, sw = size, gap = 0.5 * size, row = 1.6 * size, titleSize = 1.15 * size;
  const textW = Math.max(measure(LEGEND_TITLE, titleSize, true), sw + gap + Math.max(0, ...items.map((i) => measure(i.name, size, false))));
  const titleH = 1.5 * titleSize;
  return {
    w: 2 * pad + textW,
    h: 2 * pad + titleH + items.length * row - (row - sw) / 2,
    title: { x: pad, y: pad + titleSize, size: titleSize },
    rows: items.map((it, i) => {
      const top = pad + titleH + i * row;
      return { ...it, swatch: { x: pad, y: top, w: sw, h: sw }, text: { x: pad + sw + gap, y: top + 0.82 * sw, size } };
    }),
  };
}

/** Default placement: top-left of the sheet, text ~1/120 of the page width (≈10 mm on A0). */
export const defaultLegend = (pageW: number, pageH: number): LegendState => ({ x: 0.03 * pageW, y: 0.04 * pageH, size: pageW / 120 });

const SVG_NS = "http://www.w3.org/2000/svg";
let ctx: CanvasRenderingContext2D | null = null;
/** Browser text measure matching the export's Helvetica closely (Arial has the same widths). */
export const measureCanvas: Measure = (text, size, bold) => {
  ctx ??= document.createElement("canvas").getContext("2d")!;
  ctx.font = `${bold ? "bold " : ""}${size}px Helvetica, Arial, sans-serif`;
  return ctx.measureText(text).width;
};

/** Draw into `g` (view space). data-legend="move" on the box, "resize" on the corner handle. */
export function renderLegendSvg(g: SVGGElement, state: LegendState, items: LegendItem[], opacity: number, handle: number): void {
  const L = legendLayout(items, state.size, measureCanvas);
  const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const box = el("g", { transform: `translate(${state.x} ${state.y})`, "data-legend": "move", "data-w": L.w, class: "legend" });
  box.append(el("rect", { width: L.w, height: L.h, class: "legend-bg" }));
  box.append(el("text", { x: L.title.x, y: L.title.y, "font-size": L.title.size, "font-weight": "bold" }, LEGEND_TITLE));
  for (const r of L.rows) {
    box.append(el("rect", { x: r.swatch.x, y: r.swatch.y, width: r.swatch.w, height: r.swatch.h, fill: r.colour, "fill-opacity": opacity, stroke: r.colour }));
    box.append(el("text", { x: r.text.x, y: r.text.y, "font-size": r.text.size }, r.name));
  }
  box.append(el("rect", { x: L.w - handle / 2, y: L.h - handle / 2, width: handle, height: handle, class: "legend-handle", "data-legend": "resize" }));
  g.replaceChildren(box);
}
