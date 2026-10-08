import { apply, screenToPdf, type Mat, type Pt, type ViewState } from "./coords";
import { renderRegion, type PDFPageProxy } from "./pdf";

const SVG_NS = "http://www.w3.org/2000/svg";
const BASE_MAX_PX = 4096;   // longest side of the always-present low-res render (A0 ~ 1.2 px/pt)
const DETAIL_MAX_PX = 16e6; // iOS Safari canvas area limit is ~16.7M px
const MAX_ZOOM = 20;        // CSS px per pt
const SETTLE_MS = 200;

/** Receives pointer input on the page. Points are PDF user-space. */
export interface Tool {
  /** Primary-button press. Return true to own this drag (no panning, gets drag/up). */
  down?(p: Pt, target: Element): boolean;
  drag?(p: Pt): void;
  up?(p: Pt, moved: boolean): void;
  /** Primary press + release without moving: a click/tap. `target` is the element pressed. */
  tap?(p: Pt, target: Element): void;
  /** Second primary press within DOUBLE_MS of the first, near it. Replaces that press's down/tap. */
  doubleTap?(p: Pt, target: Element): void;
  /** Mouse moving with no button pressed. */
  hover?(p: Pt): void;
}

// Own double-tap detection: native dblclick needs both clicks on the same element, but tools re-render
// handles on press (detaching the pressed element), and iPad Safari's touch dblclick is unreliable.
const DOUBLE_MS = 400, DOUBLE_PX = 16;

interface Gesture { id: number; start: Pt; moved: boolean; owned: boolean; primary: boolean; target: Element }

/**
 * Pan/zoom viewer. One CSS transform on `stage` moves the base canvas, the sharp detail canvas and the SVG
 * overlay together, so overlay and page can never drift. Stage is sized in view units (1 CSS px = 1 pt).
 * `overlay` is a <g> carrying the PDF->view matrix: draw children in raw PDF user-space coordinates.
 */
export class Viewer {
  readonly view: ViewState = { zoom: 1, panX: 0, panY: 0 };
  pdfToView: Mat = [1, 0, 0, 1, 0, 0];
  width = 0;
  height = 0;
  readonly stage = document.createElement("div");
  readonly svg = document.createElementNS(SVG_NS, "svg");
  readonly overlay = document.createElementNS(SVG_NS, "g");
  onViewChange?: () => void;
  onCursor?: (pdf: Pt | null) => void;
  tool: Tool | null = null;

  private base = document.createElement("canvas");
  private detail: HTMLCanvasElement | null = null;
  private page: PDFPageProxy | null = null;
  private rotation = 0; // degrees clockwise, absolute (page's own + the floor's)
  private baseScale = 1;
  private minZoom = 0.01;
  private needsFit = false;
  private baseTask?: { cancel(): void };
  private detailTask?: { cancel(): void };
  private detailTimer = 0;
  private pointers = new Map<number, Pt>();
  private gesture: Gesture | null = null;
  private lastPress: { t: number; at: Pt } | null = null;

  constructor(readonly el: HTMLElement) {
    this.stage.className = "stage";
    this.base.className = "base";
    this.svg.append(this.overlay);
    this.stage.append(this.base, this.svg);
    el.append(this.stage);

    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      this.zoomAt(this.local(e), Math.exp(-px * (e.ctrlKey ? 0.01 : 0.002))); // ctrlKey = trackpad pinch
    }, { passive: false });
    el.addEventListener("pointerdown", (e) => this.pointerDown(e));
    el.addEventListener("pointermove", (e) => this.pointerMove(e));
    el.addEventListener("pointerup", (e) => this.pointerUp(e, true));
    el.addEventListener("pointercancel", (e) => this.pointerUp(e, false));
    el.addEventListener("pointerleave", () => this.onCursor?.(null));
    new ResizeObserver(() => {
      if (!this.page || !el.clientWidth) return;
      if (this.needsFit) this.fit(); // page was loaded while the viewer was hidden
      else this.scheduleDetail();
    }).observe(el);
  }

  /** Show `page` turned a further `rotate` degrees clockwise (multiple of 90). */
  async setPage(page: PDFPageProxy, rotate = 0): Promise<void> {
    this.clear();
    this.page = page;
    this.rotation = (page.rotate + rotate) % 360;
    const vp = page.getViewport({ scale: 1, rotation: this.rotation });
    this.pdfToView = vp.transform as Mat;
    this.width = vp.width;
    this.height = vp.height;
    this.stage.style.width = `${vp.width}px`;
    this.stage.style.height = `${vp.height}px`;
    this.svg.setAttribute("viewBox", `0 0 ${vp.width} ${vp.height}`);
    this.overlay.setAttribute("transform", `matrix(${this.pdfToView.join(" ")})`);
    this.fit();

    this.baseScale = Math.min(3, BASE_MAX_PX / Math.max(vp.width, vp.height));
    const { task, done } = renderRegion(page, this.base, this.baseScale, 0, 0, vp.width, vp.height, this.rotation);
    this.baseTask = task;
    await done;
  }

  clear(): void {
    this.baseTask?.cancel();
    this.detailTask?.cancel();
    this.detail?.remove();
    this.detail = null;
    this.page = null;
    this.base.width = 0;
  }

  fit(): void {
    const pad = 16, w = this.el.clientWidth, h = this.el.clientHeight;
    this.needsFit = !w;
    if (!this.width || !w) return;
    const z = Math.max(1e-3, Math.min((w - 2 * pad) / this.width, (h - 2 * pad) / this.height));
    this.minZoom = z / 2;
    Object.assign(this.view, { zoom: z, panX: (w - this.width * z) / 2, panY: (h - this.height * z) / 2 });
    this.update();
  }

  /** Zoom by `factor` keeping screen point `at` fixed. */
  zoomAt([sx, sy]: Pt, factor: number): void {
    const v = this.view;
    const z = Math.min(MAX_ZOOM, Math.max(this.minZoom, v.zoom * factor));
    const f = z / v.zoom;
    v.panX = sx - (sx - v.panX) * f;
    v.panY = sy - (sy - v.panY) * f;
    v.zoom = z;
    this.update();
  }

  /** Centre the view on PDF point `p`, zooming in to at least `zoom`. */
  centreOn(p: Pt, zoom: number): void {
    this.centreView(apply(this.pdfToView, p), Math.max(this.view.zoom, zoom));
  }

  /** Centre on the PDF-space polygon `pts`, zoomed so it fills about a third of the view. */
  showPolygon(pts: Pt[]): void {
    const v = pts.map((p) => apply(this.pdfToView, p)), xs = v.map((p) => p[0]), ys = v.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const zoom = 0.35 * Math.min(this.el.clientWidth / (x1 - x0 || 1), this.el.clientHeight / (y1 - y0 || 1));
    this.centreView([(x0 + x1) / 2, (y0 + y1) / 2], zoom);
  }

  private centreView([x, y]: Pt, zoom: number): void {
    this.view.zoom = Math.min(MAX_ZOOM, Math.max(this.minZoom, zoom));
    this.view.panX = this.el.clientWidth / 2 - x * this.view.zoom;
    this.view.panY = this.el.clientHeight / 2 - y * this.view.zoom;
    this.update();
  }

  zoomCentre(factor: number): void {
    this.zoomAt([this.el.clientWidth / 2, this.el.clientHeight / 2], factor);
  }

  toPdf(e: { clientX: number; clientY: number }): Pt {
    return screenToPdf(this.pdfToView, this.view, this.local(e));
  }

  private local(e: { clientX: number; clientY: number }): Pt {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return; // left/touch/pen, or middle = pan
    // Only the page area; overlays like the empty-state "Add PDF" button must get their own clicks
    // (pointer capture would retarget the click to the viewer).
    if (e.target !== this.el && !this.stage.contains(e.target as Node)) return;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size > 1) return this.endGesture(e, false); // second finger: pinch takes over
    const primary = e.button === 0, target = e.target as Element, at = this.local(e), last = this.lastPress;
    const double = primary && !!last && e.timeStamp - last.t < DOUBLE_MS && Math.hypot(at[0] - last.at[0], at[1] - last.at[1]) < DOUBLE_PX;
    this.lastPress = primary && !double ? { t: e.timeStamp, at } : null;
    if (double && this.page) this.tool?.doubleTap?.(this.toPdf(e), target);
    const owned = !!(primary && !double && this.page && this.tool?.down?.(this.toPdf(e), target));
    // A double-tap's second press can still pan if dragged, but is never a tap.
    this.gesture = { id: e.pointerId, start: at, moved: false, owned, primary: primary && !double, target };
  }

  private pointerUp(e: PointerEvent, allowTap: boolean): void {
    if (this.gesture?.id === e.pointerId) this.endGesture(e, allowTap);
    this.pointers.delete(e.pointerId);
  }

  private endGesture(e: PointerEvent, allowTap: boolean): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g || !this.page) return;
    if (g.owned) this.tool?.up?.(this.toPdf(e), g.moved);
    else if (allowTap && g.primary && !g.moved) this.tool?.tap?.(this.toPdf(e), g.target);
  }

  private pointerMove(e: PointerEvent): void {
    if (this.page) this.onCursor?.(this.toPdf(e));
    let prev = this.pointers.get(e.pointerId);
    if (!prev) {
      if (this.page && e.pointerType === "mouse") this.tool?.hover?.(this.toPdf(e));
      return;
    }
    const cur = this.local(e);
    this.pointers.set(e.pointerId, cur);
    const g = this.gesture;
    if (g && !g.moved) {
      // Nothing moves until the pointer leaves the slop radius, so clicks don't nudge the view.
      const slop = e.pointerType === "touch" ? 10 : 4;
      if (Math.hypot(cur[0] - g.start[0], cur[1] - g.start[1]) < slop) return;
      g.moved = true;
      prev = g.start;
    }
    if (g?.owned) return this.tool?.drag?.(this.toPdf(e));
    if (this.pointers.size === 1) {
      this.view.panX += cur[0] - prev[0];
      this.view.panY += cur[1] - prev[1];
      this.update();
    } else if (this.pointers.size === 2) {
      // Pinch: the other finger is fixed for this event; zoom about the new midpoint, then pan by midpoint travel.
      const other = [...this.pointers].find(([id]) => id !== e.pointerId)![1];
      const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
      const d1 = Math.hypot(cur[0] - other[0], cur[1] - other[1]);
      const m0: Pt = [(prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2];
      const m1: Pt = [(cur[0] + other[0]) / 2, (cur[1] + other[1]) / 2];
      this.view.panX += m1[0] - m0[0];
      this.view.panY += m1[1] - m0[1];
      this.zoomAt(m1, d0 > 0 ? d1 / d0 : 1);
    }
  }

  private update(): void {
    const { zoom, panX, panY } = this.view;
    this.stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    this.scheduleDetail();
    this.onViewChange?.();
  }

  private scheduleDetail(): void {
    clearTimeout(this.detailTimer);
    this.detailTimer = window.setTimeout(() => this.renderDetail().catch(console.error), SETTLE_MS);
  }

  // ponytail: re-renders the whole visible region after each settle (pdf.js rasterises every path each time,
  // ~0.5-1.5 s on the A0 sample). Add a tile cache if users find pans at high zoom too slow.
  private async renderDetail(): Promise<void> {
    const page = this.page;
    if (!page) return;
    this.detailTask?.cancel();
    const { zoom, panX, panY } = this.view;
    let scale = zoom * devicePixelRatio;
    if (scale <= this.baseScale * 1.1) { // base render is already sharp enough
      this.detail?.remove();
      this.detail = null;
      return;
    }
    const x0 = Math.max(0, -panX / zoom), y0 = Math.max(0, -panY / zoom);
    const x1 = Math.min(this.width, (this.el.clientWidth - panX) / zoom);
    const y1 = Math.min(this.height, (this.el.clientHeight - panY) / zoom);
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0;
    scale = Math.min(scale, Math.sqrt(DETAIL_MAX_PX / (w * h)));

    const canvas = document.createElement("canvas");
    canvas.className = "detail";
    Object.assign(canvas.style, { left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${h}px` });
    const { task, done } = renderRegion(page, canvas, scale, x0, y0, w, h, this.rotation);
    this.detailTask = task;
    if (!(await done) || page !== this.page) return;
    // Swap only when finished, so the old sharp region stays up while the new one renders.
    if (this.detail) {
      this.detail.width = 0; // release bitmap memory now (Safari is slow to GC canvases)
      this.detail.replaceWith(canvas);
    } else this.base.after(canvas);
    this.detail = canvas;
  }
}
