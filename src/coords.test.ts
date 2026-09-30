// Run: npm test  (Node 22.18+/24 strips TS types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, invert, pdfToScreen, screenToPdf, type Mat, type Pt } from "./coords.ts";

const close = (a: Pt, b: Pt) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9, `${a} != ${b}`);

test("sample-plan.pdf: /Rotate 90, MediaBox 2384x3370 -> pdf.js transform [0,1,1,0,0,0]", () => {
  const m: Mat = [0, 1, 1, 0, 0, 0];
  close(apply(m, [0, 0]), [0, 0]);         // PDF bottom-left -> view top-left
  close(apply(m, [0, 3370]), [3370, 0]);   // PDF top-left -> view top-right
  close(apply(m, [2384, 0]), [0, 2384]);   // PDF bottom-right -> view bottom-left
});

test("unrotated page flips y", () => {
  const m: Mat = [1, 0, 0, -1, 0, 842]; // A4 portrait, pdf.js scale 1
  close(apply(m, [0, 0]), [0, 842]);
  close(apply(m, [595, 842]), [595, 0]);
});

test("screen <-> PDF round trip under zoom, pan, rotation", () => {
  for (const m of [[0, 1, 1, 0, 0, 0], [1, 0, 0, -1, 0, 842], [0, -1, -1, 0, 3370, 2384], [2, 0, 0, -2, -10, 500]] as Mat[]) {
    const v = { zoom: 3.7, panX: -1234.5, panY: 88 };
    const p: Pt = [123.4, 567.8];
    close(screenToPdf(m, v, pdfToScreen(m, v, p)), p);
    close(apply(invert(m), apply(m, p)), p);
  }
});
