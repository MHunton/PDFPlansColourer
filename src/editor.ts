import { apply, type Pt } from "./coords";
import type { LegendState } from "./legend";
import type { RoomLabel } from "./roomLabels";
import { History, nearestEdge, newId, pointInPolygon, polygonArea, snapshot, untracedLabels, type Category, type Shape } from "./shapes";
import type { Tool, Viewer } from "./viewer";

const SVG_NS = "http://www.w3.org/2000/svg";
const HANDLE_PX = matchMedia("(pointer: coarse)").matches ? 12 : 8; // vertex handle radius on screen; bigger for fingers
const CLOSE_PX = 14;  // tap this close to the first point to close the room
const GRAB_PX = matchMedia("(pointer: coarse)").matches ? 24 : 16; // invisible grab radius around each handle

export type Mode = "select" | "draw";
/** A floor's rooms, plus the room labels found in its drawing (rooms not yet traced get markers). */
type FloorShapes = { shapes: Shape[]; labels?: RoomLabel[] };

/**
 * Polygon rooms on the current floor: Select tool (select, drag/insert/delete vertices; right-click a corner to
 * remove it or an edge to add one) and Draw tool. Labelled rooms without a shape show as markers.
 */
export class Editor implements Tool {
  mode: Mode = "select";
  selectedId: string | null = null;
  draft: Pt[] = [];
  /** Colour key (owned by main, shared by all floors). */
  categories: Category[] = [];
  /** Paint mode: category id given to every room tapped or drawn; null = select only. */
  brush: string | null = null;
  onChange?: () => void; // toolbar/hint/panel refresh
  /** This floor's colour key box (view pt), if shown; dragged/resized in Select. */
  legend: LegendState | null = null;
  onLegend?: () => void;
  private legendDrag: { resize: boolean; start: Pt; orig: LegendState; w: number } | null = null;

  private floor: FloorShapes | null = null;
  private readonly history = new History<FloorShapes>();
  private readonly shapesLayer = svg("g");
  private readonly editLayer = svg("g");
  private cursor: Pt | null = null;
  private dragging: { shape: Shape; index: number; before: Shape[]; inserted: boolean } | null = null;

  constructor(private readonly viewer: Viewer) {
    viewer.overlay.append(this.shapesLayer, this.editLayer);
    viewer.el.addEventListener("contextmenu", (e) => {
      if (!this.floor || !viewer.stage.contains(e.target as Node)) return;
      e.preventDefault();
      this.rightClick(viewer.toPdf(e), e.target as Element);
    });
  }

  /** Room labels on this floor not yet placed in any room (see untracedLabels). Updated on every model change. */
  get missing(): RoomLabel[] { return this.missingCache; }
  private missingCache: RoomLabel[] = [];

  /** Select a room (e.g. from search). */
  select(id: string): void {
    this.setMode("select");
    this.selectedId = id;
    this.render();
  }

  get selected(): Shape | undefined { return this.floor?.shapes.find((s) => s.id === this.selectedId); }
  get floorShapes(): Shape[] { return this.floor?.shapes ?? []; }
  get canUndo(): boolean { return this.draft.length > 0 || (!!this.floor && this.history.canUndo(this.floor)); }
  get canRedo(): boolean { return !this.draft.length && !!this.floor && this.history.canRedo(this.floor); }

  setFloor(floor: FloorShapes | null): void {
    this.floor = floor;
    this.draft = [];
    this.selectedId = null;
    this.render();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.draft = [];
    if (mode === "draw") this.selectedId = null;
    this.viewer.el.classList.toggle("drawing", mode === "draw");
    this.render();
  }

  // ---- Tool (pointer input from Viewer) ----

  down(p: Pt, target: Element): boolean {
    const lg = target.closest("[data-legend]");
    if (lg && this.legend && this.mode === "select") {
      const w = Number(target.closest("[data-w]")?.getAttribute("data-w")) || 1;
      this.legendDrag = { resize: lg.getAttribute("data-legend") === "resize", start: apply(this.viewer.pdfToView, p), orig: { ...this.legend }, w };
      return true;
    }
    const shape = this.selected;
    if (this.mode !== "select" || !shape || target.getAttribute("data-shape") !== shape.id) return false;
    const vertex = target.getAttribute("data-vertex"), mid = target.getAttribute("data-mid");
    if (vertex === null && mid === null) return false;
    const before = snapshot(this.floor!.shapes);
    let index = Number(vertex ?? mid);
    if (mid !== null) { // drag an edge midpoint = insert a vertex there
      const a = shape.points[index], b = shape.points[(index + 1) % shape.points.length];
      shape.points.splice(++index, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    this.dragging = { shape, index, before, inserted: mid !== null };
    this.render();
    return true;
  }

  drag(p: Pt): void {
    const l = this.legendDrag;
    if (l && this.legend) {
      const [x, y] = apply(this.viewer.pdfToView, p), dx = x - l.start[0], dy = y - l.start[1];
      if (l.resize) this.legend.size = Math.max(2, l.orig.size * (l.w + dx) / l.w); // text scales with the box
      else Object.assign(this.legend, { x: l.orig.x + dx, y: l.orig.y + dy });
      return this.onLegend?.();
    }
    const d = this.dragging;
    if (!d) return;
    d.shape.points[d.index] = p;
    this.shapesLayer.querySelector(`[data-shape="${d.shape.id}"]`)?.setAttribute("points", pointsAttr(d.shape.points));
    this.renderEdit();
  }

  up(_p: Pt, moved: boolean): void {
    if (this.legendDrag) { this.legendDrag = null; return; }
    const d = this.dragging;
    this.dragging = null;
    if (d && (moved || d.inserted)) this.history.push(this.floor!, d.before);
    this.render();
  }

  tap(p: Pt, target: Element): void {
    if (!this.floor) return;
    if (this.mode === "draw") {
      if (this.draft.length >= 3 && this.screenDist(p, this.draft[0]) < CLOSE_PX) return this.finish();
      this.draft.push(p);
      this.cursor = p;
    } else if (target.hasAttribute("data-missing")) {
      return this.setMode("draw"); // tapping a missing-room marker: start drawing it
    } else {
      this.selectedId = target.closest("[data-shape]")?.getAttribute("data-shape") ?? null;
      const shape = this.selected;
      if (shape && this.brush !== null && shape.categoryId !== this.brush) return this.update({ categoryId: this.brush });
    }
    this.render();
  }

  hover(p: Pt): void {
    this.cursor = p;
    if (this.mode === "draw" && this.draft.length) this.renderEdit();
  }

  // ---- commands (toolbar / keyboard) ----

  finish(): void {
    if (!this.floor || this.draft.length < 3) return;
    const shape: Shape = { id: newId(), points: this.draft, ...(this.brush !== null && { categoryId: this.brush }) };
    // Drawn around markers: take their labels (several for an open-plan area drawn as one room).
    const labels = this.missing.filter((l) => pointInPolygon(l.at, shape.points));
    if (labels.length) {
      shape.roomNo = labels.map((l) => l.no).join(" + ");
      const name = [...new Set(labels.map((l) => l.name).filter(Boolean))].join(" + ");
      if (name) shape.name = name;
    }
    this.edit(() => this.floor!.shapes.push(shape));
    this.draft = [];
    this.selectedId = shape.id; // highlight what was just made; stay in draw mode for the next room
    this.render();
  }

  /** Add shapes to any floor (e.g. detected rooms) as one undoable step. */
  addShapes(floor: FloorShapes, shapes: Shape[]): void {
    const before = snapshot(floor.shapes);
    floor.shapes.push(...shapes);
    this.history.push(floor, before);
    if (floor === this.floor) this.render();
  }

  /** Change the selected room's fields (label, category) as one undoable step. */
  update(patch: Partial<Pick<Shape, "roomNo" | "name" | "notes" | "categoryId">>): void {
    const shape = this.selected;
    if (!shape) return;
    this.edit(() => {
      Object.assign(shape, patch);
      for (const k of Object.keys(patch) as (keyof typeof patch)[]) if (!shape[k]) delete shape[k]; // "" / undefined = cleared
    });
    this.render();
  }

  /** Re-render after categories were edited elsewhere (colour, deletion). */
  refresh(): void { this.render(); }

  cancelDraft(): void {
    this.draft = [];
    this.render();
  }

  deleteSelected(): void {
    const id = this.selectedId;
    if (!id) return;
    this.edit(() => (this.floor!.shapes = this.floor!.shapes.filter((s) => s.id !== id)));
    this.selectedId = null;
    this.render();
  }

  undo(): void {
    if (this.draft.length) this.draft.pop();
    else if (this.floor) this.history.undo(this.floor);
    this.render();
  }

  redo(): void {
    if (!this.draft.length && this.floor) this.history.redo(this.floor);
    this.render();
  }

  /** Re-draw handles at constant screen size after a zoom. */
  zoomChanged(): void { this.renderEdit(); }

  doubleTap(_p: Pt, target: Element): void {
    if (this.mode === "draw") return this.finish(); // the first tap already placed the last corner
    const shape = this.selected, vertex = target.getAttribute("data-vertex");
    if (!shape || vertex === null || shape.points.length <= 3) return;
    this.edit(() => shape.points.splice(Number(vertex), 1));
    this.render();
  }

  /** Select: corner = remove it, edge of the selected (or clicked) room = add a corner there. Draw: undo last point. */
  private rightClick(p: Pt, target: Element): void {
    if (this.mode === "draw") return this.undo();
    const vertex = target.getAttribute("data-vertex"), shape = this.selected;
    if (vertex !== null && shape) {
      if (shape.points.length > 3) this.edit(() => shape.points.splice(Number(vertex), 1));
      return this.render();
    }
    const clicked = this.floor!.shapes.find((s) => s.id === target.closest("[data-shape]")?.getAttribute("data-shape"));
    for (const s of [shape, clicked]) {
      if (!s) continue;
      const e = nearestEdge(p, s.points);
      if (e.dist * this.viewer.view.zoom < HANDLE_PX * 1.5) {
        this.selectedId = s.id;
        this.edit(() => s.points.splice(e.i + 1, 0, e.at));
        return this.render();
      }
    }
    this.selectedId = clicked?.id ?? null;
    this.render();
  }

  private edit(mutate: () => void): void {
    const before = snapshot(this.floor!.shapes);
    mutate();
    this.history.push(this.floor!, before);
  }

  private screenDist(a: Pt, b: Pt): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1]) * this.viewer.view.zoom; // pdf->view is rotation only (scale 1)
  }

  // ---- rendering ----

  private render(): void {
    if (this.selectedId && !this.selected) this.selectedId = null; // e.g. undone away
    this.missingCache = this.floor ? untracedLabels(this.floor.shapes, this.floor.labels ?? []) : [];
    // Largest first, so a room inside another stays on top and clickable.
    const shapes = [...(this.floor?.shapes ?? [])].sort((a, b) => polygonArea(b.points) - polygonArea(a.points));
    this.shapesLayer.replaceChildren(...shapes.map((s) => {
      const el = svg("polygon", { points: pointsAttr(s.points), class: "shape", "data-shape": s.id });
      const cat = s.categoryId && this.categories.find((c) => c.id === s.categoryId);
      if (cat) { el.classList.add("cat"); el.style.setProperty("--c", cat.colour); }
      if (s.roomNo || s.notes) { // hover tooltip
        const title = svg("title");
        title.textContent = [s.roomNo, s.name, cat && `(${cat.name})`].filter(Boolean).join(" ") + (s.notes ? `
${s.notes}` : "");
        el.append(title);
      }
      if (s.id === this.selectedId) el.classList.add("selected");
      return el;
    }));
    this.renderEdit();
    this.onChange?.();
  }

  private renderEdit(): void {
    const r = HANDLE_PX / this.viewer.view.zoom;
    const layer = this.editLayer;
    layer.replaceChildren();
    for (const l of this.missing) {
      const m = svg("circle", { cx: l.at[0], cy: l.at[1], r: r * 1.6, class: "missing", "data-missing": l.no });
      const title = svg("title");
      title.textContent = `${l.no} ${l.name}: not traced. Draw it with Draw room.`;
      m.append(title);
      layer.append(m);
    }
    const shape = this.selected;
    if (this.mode === "select" && shape) {
      // Each handle: a visible dot plus a larger invisible grab circle (capped so neighbours don't overlap).
      const pts = shape.points, z = this.viewer.view.zoom, n = pts.length;
      const edge = (i: number) => Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]) * z; // screen px
      const handle = (cx: number, cy: number, dot: number, grab: number, cls: string, attr: string, i: number) => {
        layer.append(svg("circle", { cx, cy, r: dot, class: `handle ${cls}` }));
        layer.append(svg("circle", { cx, cy, r: Math.max(dot, grab), class: `handle-hit ${cls}`, "data-shape": shape.id, [attr]: i }));
      };
      pts.forEach((a, i) => { // midpoints (add a corner), skipped on edges too short to hold one
        const b = pts[(i + 1) % n];
        if (edge(i) >= 5 * HANDLE_PX) handle((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, r * 0.7, Math.min(GRAB_PX * 0.8, edge(i) / 4) / z, "mid", "data-mid", i);
      });
      pts.forEach(([x, y], i) => handle(x, y, r, Math.min(GRAB_PX, 0.45 * Math.min(edge(i), edge((i + n - 1) % n))) / z, "", "data-vertex", i));
    }
    if (this.mode === "draw" && this.draft.length) {
      const pts = this.cursor ? [...this.draft, this.cursor] : this.draft;
      layer.append(svg("polygon", { points: pointsAttr(pts), class: "draft-fill" }));
      layer.append(svg("polyline", { points: pointsAttr(pts), class: "draft" }));
      const [x, y] = this.draft[0];
      const canClose = this.draft.length >= 3;
      const near = canClose && !!this.cursor && this.screenDist(this.cursor, this.draft[0]) < CLOSE_PX;
      layer.append(svg("circle", { cx: x, cy: y, r: canClose ? r * 1.4 : r * 0.6, class: `close-target${near ? " near" : ""}` }));
      for (const [px, py] of this.draft.slice(1)) layer.append(svg("circle", { cx: px, cy: py, r: r * 0.6, class: "draft-pt" }));
    }
  }
}

const pointsAttr = (pts: Pt[]) => pts.map(([x, y]) => `${x},${y}`).join(" ");

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
