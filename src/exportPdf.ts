// PDF export: every floor's original page copied untouched into one document, coloured rooms drawn on top as
// vector fills, the colour key drawn as vector boxes and text, and the editable project attached.
import { apply, invert, type Mat, type Pt } from "./coords";
import { LEGEND_TITLE, legendLayout, type LegendItem, type LegendState } from "./legend";
import { PROJECT_ATTACHMENT } from "./project";
import type { Category, Shape } from "./shapes";

export interface ExportFloor {
  bytes: Uint8Array;  // original source PDF
  page: number;       // 1-based page in it
  pdfToView: Mat;     // pdf.js viewport transform at scale 1 (rotation applied)
  shapes: Shape[];
  legend: LegendState | null;
}

export async function exportPdf(floors: ExportFloor[], categories: Category[], opacity: number, projectJson: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import("pdf-lib"); // loaded on first export only
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica), bold = await out.embedFont(StandardFonts.HelveticaBold);
  const colour = (hex: string) => rgb(...([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]));
  // Standard fonts only encode WinAnsi (Latin-1-ish): replace anything else rather than fail the export.
  const safe = (t: string) => t.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
  const sources = new Map<Uint8Array, Awaited<ReturnType<typeof PDFDocument.load>>>();

  for (const f of floors) {
    let src = sources.get(f.bytes);
    if (!src) sources.set(f.bytes, (src = await PDFDocument.load(f.bytes, { ignoreEncryption: true })));
    const [page] = await out.copyPages(src, [f.page - 1]);
    out.addPage(page);

    for (const s of f.shapes) {
      const cat = categories.find((c) => c.id === s.categoryId);
      if (!cat || s.points.length < 3) continue;
      // drawSvgPath flips y (SVG is y-down), so negate y to land exactly on PDF user-space coordinates.
      const path = "M" + s.points.map(([x, y]) => `${x},${-y}`).join("L") + "Z";
      page.drawSvgPath(path, { x: 0, y: 0, color: colour(cat.colour), opacity, borderColor: colour(cat.colour), borderWidth: 0.5, borderOpacity: 0.9 });
    }

    const items: LegendItem[] = categories.map((c) => ({ name: safe(c.name), colour: c.colour }));
    if (!f.legend || !items.length) continue;
    // Legend is laid out in view space (upright as seen); map each box/baseline into PDF space and rotate with it.
    const toPdf = invert(f.pdfToView);
    const at = (x: number, y: number): Pt => apply(toPdf, [f.legend!.x + x, f.legend!.y + y]);
    const [dx, dy] = [toPdf[0], toPdf[1]]; // view +x direction in PDF space
    const rotate = degrees((Math.atan2(dy, dx) * 180) / Math.PI);
    const L = legendLayout(items, f.legend.size, (t, size, b) => (b ? bold : font).widthOfTextAtSize(t, size));
    const rect = (x: number, y: number, w: number, h: number, o: object) => { const [px, py] = at(x, y + h); page.drawRectangle({ x: px, y: py, width: w, height: h, rotate, ...o }); };
    const text = (t: string, x: number, y: number, size: number, b = false) => { const [px, py] = at(x, y); page.drawText(t, { x: px, y: py, size, font: b ? bold : font, rotate, color: rgb(0.1, 0.1, 0.12) }); };
    rect(0, 0, L.w, L.h, { color: rgb(1, 1, 1), borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.6 });
    text(LEGEND_TITLE, L.title.x, L.title.y, L.title.size, true);
    for (const r of L.rows) {
      rect(r.swatch.x, r.swatch.y, r.swatch.w, r.swatch.h, { color: colour(r.colour), opacity, borderColor: colour(r.colour), borderWidth: 0.5 });
      text(r.name, r.text.x, r.text.y, r.text.size);
    }
  }

  await out.attach(new TextEncoder().encode(projectJson), PROJECT_ATTACHMENT, {
    mimeType: "application/json",
    description: "Editable Plan Colour-Coder project: open this PDF in Plan Colour-Coder to continue",
  });
  out.setProducer("Plan Colour-Coder");
  return out.save();
}
