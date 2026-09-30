// Coordinate spaces:
//   PDF  - page user space, points, origin bottom-left, unrotated. Source of truth for all stored shapes.
//   view - pdf.js viewport at scale 1: rotation applied, origin top-left, y down, 1 unit = 1 pt = 1 CSS px at zoom 1.
//   screen - CSS px relative to the viewer element: screen = view * zoom + pan.
// PDF -> view is pdf.js `page.getViewport({ scale: 1 }).transform`.

export type Pt = [number, number];
export type Mat = [number, number, number, number, number, number];

export const apply = (m: Mat, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function invert([a, b, c, d, e, f]: Mat): Mat {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export interface ViewState { zoom: number; panX: number; panY: number }

export const viewToScreen = (v: ViewState, [x, y]: Pt): Pt => [x * v.zoom + v.panX, y * v.zoom + v.panY];
export const screenToView = (v: ViewState, [x, y]: Pt): Pt => [(x - v.panX) / v.zoom, (y - v.panY) / v.zoom];

export const pdfToScreen = (pdfToView: Mat, v: ViewState, p: Pt): Pt => viewToScreen(v, apply(pdfToView, p));
export const screenToPdf = (pdfToView: Mat, v: ViewState, p: Pt): Pt => apply(invert(pdfToView), screenToView(v, p));
