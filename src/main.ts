import "./style.css";
import { Editor } from "./editor";
import { editFloors, type Floor, type Source } from "./floorDialog";
import { floorRank } from "./floorName";
import { exportPdf, type ExportFloor } from "./exportPdf";
import { KeyPanel } from "./key";
import { defaultLegend, renderLegendSvg } from "./legend";
import { loadPdf, type PDFPageProxy } from "./pdf";
import { clearSession, loadSession, peekSession, saveSession } from "./autosave";
import { fromProjectFile, parseProject, PROJECT_ATTACHMENT, roomCsv, toProjectFile, type ProjectState } from "./project";
import { detectRooms } from "./rooms";
import { searchRooms, type Hit } from "./search";
import { newId, type Category } from "./shapes";
import { Viewer } from "./viewer";
import type { Mat } from "./coords";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DEBUG = new URLSearchParams(location.search).has("debug");

const viewer = new Viewer($("viewer"));
const debugLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
viewer.overlay.append(debugLayer);
const editor = new Editor(viewer);
viewer.tool = editor;
const legendLayer = document.createElementNS("http://www.w3.org/2000/svg", "g"); // view space, above the rooms
viewer.svg.append(legendLayer);
let showLegend = true;
let floors: Floor[] = [];
let current: Floor | null = null;
const categories: Category[] = [];
const colourKey = new KeyPanel(categories, editor, () => floors.flatMap((f) => f.shapes));

const say = (msg: string) => ($("msg").textContent = msg);
const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";
async function addFiles(files: File[]) {
  const pdfs = files.filter(isPdf);
  const added: Floor[] = [];
  const problems = files.filter((f) => !isPdf(f)).map((f) => `${f.name} is not a PDF.`);
  for (const file of pdfs) {
    say(`Opening ${file.name}…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const task = loadPdf(bytes.slice()); // pdf.js detaches the buffer it is given; keep the original for export
      const src: Source = { id: newId(), fileName: file.name, bytes, task, doc: await task.promise };
      const project = await embeddedProject(src);
      if (project && confirm(`${file.name} was exported by Plan Colour-Coder. Open its editable project?\n\nCancel adds it as a plain drawing instead.`)) {
        task.destroy();
        return openProject(file.name, project);
      }
      for (let p = 1; p <= src.doc.numPages; p++) added.push({ name: "", src, page: p, shapes: [] });
    } catch (e) {
      problems.push(`Could not open ${file.name}: ${(e as Error).message}`);
    }
  }
  say("");
  if (problems.length) alert(problems.join("\n")); // status line would be overwritten by the next render
  if (!added.length) return;
  startAutosave();
  await manageFloors(added);
}

async function manageFloors(added: Floor[] = []) {
  const all = [...floors, ...added];
  const result = await editFloors(all, new Set(added));
  if (result) floors = result.sort((a, b) => floorRank(a.name) - floorRank(b.name));
  // Free pdf.js memory for files no floor uses any more (cancelled adds, removed floors).
  const used = new Set(floors.map((f) => f.src));
  for (const src of new Set(all.map((f) => f.src))) if (!used.has(src)) src.task.destroy();

  showChrome();
  markDirty();
  if (!floors.length) {
    current = null;
    renderTabs();
    viewer.clear();
    editor.setFloor(null);
    return say("");
  }
  for (const f of added) if (floors.includes(f)) findRooms(f);
  // Show the first newly added floor; otherwise stay put (no re-render, keeps zoom) unless the current one was removed.
  const next = added.find((f) => floors.includes(f)) ?? (current && floors.includes(current) ? current : floors[0]);
  if (next !== current) return showFloor(next);
  renderTabs();
  say(floorStatus(next));
}

const floorStatus = (f: Floor) =>
  `${f.name} · ${f.src.fileName}, page ${f.page} · ${Math.round(viewer.width)} × ${Math.round(viewer.height)} pt`;

// One floor at a time, in the background. Rooms become ordinary shapes (undo removes them all in one step).
let detecting = Promise.resolve();
function findRooms(floor: Floor) {
  detecting = detecting.then(async () => {
    if (!floors.includes(floor)) return;
    const status = (text: string) => { if (current === floor || !current) say(text); };
    status(`Finding rooms on ${floor.name}…`);
    try {
      const page = await floor.src.doc.getPage(floor.page);
      const t0 = performance.now();
      const res = await detectRooms(page, (pct) => status(`Finding rooms on ${floor.name}… ${Math.round(pct)}%`));
      if (!floors.includes(floor)) return;
      floor.labels = res.labels;
      floor.scale = res.scale;
      editor.addShapes(floor, res.rooms.map((r) => ({ id: newId(), points: r.points, roomNo: r.no, name: r.name })));
      markDirty();
      const missed = res.labels.length - res.rooms.length;
      say(res.labels.length
        ? `${floor.name}: found ${res.rooms.length} rooms in ${((performance.now() - t0) / 1000).toFixed(1)} s` +
          (missed > 0 ? ` · ${missed} not traced: red markers, use "Missing" to go to each` : "")
        : `${floor.name}: no room numbers found in the drawing text. Draw rooms with Draw room.`);
    } catch (e) {
      console.error(e);
      say(`${floor.name}: room detection failed (${(e as Error).message}). Draw rooms with Draw room.`);
    }
  });
}

async function showFloor(floor: Floor) {
  current = floor;
  renderTabs();
  editor.setFloor(null);
  debugLayer.replaceChildren();
  say("Rendering…");
  const page = await floor.src.doc.getPage(floor.page);
  if (current !== floor) return;
  await viewer.setPage(page, floor.rotation);
  if (current !== floor) return;
  floor.legend ??= defaultLegend(viewer.width, viewer.height);
  editor.setFloor(floor);
  say(floorStatus(floor));
  if (DEBUG) await drawTextBoxes(page, floor);
}

function renderTabs() {
  $("tabList").replaceChildren(...floors.map((f) => {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.role = "tab";
    tab.textContent = f.name;
    tab.ariaSelected = String(f === current);
    tab.addEventListener("click", () => f !== current && showFloor(f));
    return tab;
  }));
  $("tabList").querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ?debug: outline every PDF text item in the overlay. If boxes sit on the text at every zoom, alignment is right.
async function drawTextBoxes(page: PDFPageProxy, floor: Floor) {
  const tc = await page.getTextContent();
  if (current !== floor) return;
  for (const it of tc.items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform as number[];
    const n1 = Math.hypot(a, b), n2 = Math.hypot(c, d);
    const dx = (a / n1) * it.width, dy = (b / n1) * it.width, ux = (c / n2) * it.height, uy = (d / n2) * it.height;
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", `${e},${f} ${e + dx},${f + dy} ${e + dx + ux},${f + dy + uy} ${e + ux},${f + uy}`);
    poly.setAttribute("class", "debug-box");
    debugLayer.append(poly);
  }
}

viewer.onViewChange = () => {
  $("zoomPct").textContent = `${Math.round((viewer.view.zoom * 72) / 96 * 100)}%`; // 100% = paper size
  editor.zoomChanged();
  renderLegend(); // corner handle stays a constant size on screen
};

const HINTS = {
  select: "Tap a room to select it. Drag corners to adjust. Right-click an edge to add a corner, a corner to remove it.",
  draw: "Tap each corner of the room. Tap the first point, double-click or press Finish to close it. Right-click undoes a point.",
};
editor.onChange = () => {
  $("toolSelect").ariaPressed = String(editor.mode === "select");
  $("toolDraw").ariaPressed = String(editor.mode === "draw");
  $("drawGroup").hidden = editor.mode !== "draw" || !editor.draft.length;
  $<HTMLButtonElement>("finishShape").disabled = editor.draft.length < 3;
  $<HTMLButtonElement>("undo").disabled = !editor.canUndo;
  $<HTMLButtonElement>("redo").disabled = !editor.canRedo;
  $<HTMLButtonElement>("deleteShape").disabled = !editor.selected;
  const missing = editor.missing.length;
  $("nextMissing").hidden = !missing;
  $("nextMissing").textContent = `Missing: ${missing}`;
  const sel = editor.selected;
  $("hint").textContent = !current ? "" : sel && editor.mode === "select"
    ? `${sel.roomNo ? `${sel.roomNo} ${sel.name ?? ""}` : "Room (no number)"} · drag corners, right-click to add/remove corners`
    : editor.brush !== null
      ? `Painting with "${categories.find((c) => c.id === editor.brush)?.name}": tap rooms to colour them. Esc stops.`
      : HINTS[editor.mode];
  colourKey.refresh();
  renderLegend();
  $("hint").hidden = !current;
  markDirty();
};
$("toolSelect").addEventListener("click", () => editor.setMode("select"));
$("toolDraw").addEventListener("click", () => editor.setMode("draw"));
$("finishShape").addEventListener("click", () => editor.finish());
$("cancelShape").addEventListener("click", () => editor.cancelDraft());
$("undo").addEventListener("click", () => editor.undo());
$("redo").addEventListener("click", () => editor.redo());
$("deleteShape").addEventListener("click", () => editor.deleteSelected());
let missingIndex = 0;
$("nextMissing").addEventListener("click", () => { // cycle through untraced rooms
  const list = editor.missing;
  if (!list.length) return;
  const l = list[missingIndex++ % list.length];
  viewer.centreOn(l.at, 3);
  say(`Missing: ${l.no} ${l.name}. Tap its red marker or choose Draw room, then tap the room's corners.`);
});
viewer.onCursor = (p) => ($("cursor").textContent = p ? `x ${p[0].toFixed(1)}  y ${p[1].toFixed(1)} pt` : "");

for (const input of document.querySelectorAll<HTMLInputElement>("input[type=file]")) {
  input.addEventListener("change", () => {
    if (input.files?.length) addFiles([...input.files]);
    input.value = ""; // allow adding the same file again
  });
}
$("editFloors").addEventListener("click", () => manageFloors());
$("zoomIn").addEventListener("click", () => viewer.zoomCentre(1.5));
$("zoomOut").addEventListener("click", () => viewer.zoomCentre(1 / 1.5));
$("zoomFit").addEventListener("click", () => viewer.fit());
// Turn the plan (view only: rooms are stored in PDF space). The key box is placed in view space: start it afresh.
async function rotate(by: number) {
  if (!current) return;
  current.rotation = ((current.rotation ?? 0) + by + 360) % 360;
  current.legend = undefined;
  await showFloor(current);
  markDirty();
}
$("rotateLeft").addEventListener("click", () => rotate(-90));
$("rotateRight").addEventListener("click", () => rotate(90));

addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length && !$<HTMLDialogElement>("floorDialog").open) addFiles(files);
});
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && floors.length) {
    e.preventDefault();
    document.body.classList.remove("panel-hidden");
    $<HTMLInputElement>("search").select();
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement ||
    $<HTMLDialogElement>("floorDialog").open || !current) return;
  const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (ctrl && key === "z") editor[e.shiftKey ? "redo" : "undo"]();
  else if (ctrl && key === "y") editor.redo();
  else if (ctrl) return;
  else if (key === "v") editor.setMode("select");
  else if (key === "d") editor.setMode("draw");
  else if (e.key === "Enter") editor.finish();
  else if (e.key === "Escape") editor.draft.length ? editor.cancelDraft() : editor.brush !== null ? colourKey.setBrush(null) : editor.setMode("select");
  else if (e.key === "Delete" || e.key === "Backspace") editor.draft.length ? editor.undo() : editor.deleteSelected();
  else if (e.key === "+" || e.key === "=") viewer.zoomCentre(1.5);
  else if (e.key === "-") viewer.zoomCentre(1 / 1.5);
  else if (e.key === "0") viewer.fit();
  else if (key === "r") rotate(e.shiftKey ? -90 : 90);
  else if ((e.key === "PageUp" || e.key === "PageDown") && current) { // PageUp = floor above
    const next = floors[floors.indexOf(current) + (e.key === "PageUp" ? 1 : -1)];
    if (next) showFloor(next);
  } else return;
  e.preventDefault(); // e.g. Backspace navigating back, Ctrl+Y opening history
});

$("togglePanel").addEventListener("click", () => document.body.classList.toggle("panel-hidden"));
if (matchMedia("(max-width: 760px)").matches) document.body.classList.add("panel-hidden"); // phones: plan first

// Autosave covers closing the tab; warn only if it can't (unavailable, or changes not written yet).
addEventListener("beforeunload", (e) => { if (floors.some((f) => f.shapes.length) && (dirty || !autosaveOk)) e.preventDefault(); });

// ---- find room ----
const search = $<HTMLInputElement>("search");
let hits: Hit<Floor>[] = [];
function renderResults() {
  hits = searchRooms(floors, search.value);
  $("results").replaceChildren(...hits.map((hit) => {
    const li = document.createElement("li"), b = document.createElement("button");
    b.innerHTML = `<span></span><span class="where"></span>`;
    b.children[0].textContent = hit.text;
    b.children[1].textContent = hit.label ? `not traced · ${hit.floor.name}` : hit.floor.name;
    b.children[1].classList.toggle("untraced", !!hit.label);
    b.addEventListener("click", () => goTo(hit));
    li.append(b);
    return li;
  }));
  if (search.value.trim() && !hits.length) say(`No room matches "${search.value.trim()}".`);
}
async function goTo(hit: Hit<Floor>) {
  if (hit.floor !== current) await showFloor(hit.floor);
  if (current !== hit.floor) return;
  if (hit.shape) {
    editor.select(hit.shape.id);
    viewer.showPolygon(hit.shape.points);
  } else if (hit.label) {
    viewer.centreOn(hit.label.at, 3);
    say(`${hit.text}: not traced yet. Draw it with Draw room around the red marker.`);
  }
  if (matchMedia("(max-width: 760px)").matches) document.body.classList.add("panel-hidden"); // phones: show the plan
}
search.addEventListener("input", renderResults);
search.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && hits[0]) goTo(hits[0]);
  else if (e.key === "Escape") { search.value = ""; renderResults(); search.blur(); }
});

// ---- legend, save, export, open ----
function showChrome() {
  $("empty").hidden = floors.length > 0;
  $("tabs").hidden = floors.length === 0;
  $("editTools").hidden = floors.length === 0;
  $("rotateTools").hidden = floors.length === 0;
  $("exportPanel").hidden = floors.length === 0;
}

function renderLegend() {
  const f = current;
  editor.legend = f && showLegend && categories.length && f.legend && editor.floorShapes === f.shapes ? f.legend : null;
  if (!editor.legend) return legendLayer.replaceChildren();
  renderLegendSvg(legendLayer, editor.legend, categories, colourKey.opacity, 12 / viewer.view.zoom);
}
editor.onLegend = () => { renderLegend(); markDirty(); };
$<HTMLInputElement>("showLegend").addEventListener("change", (e) => { showLegend = (e.target as HTMLInputElement).checked; renderLegend(); markDirty(); });

const baseName = () => (floors[0]?.src.fileName ?? "plan").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_");
function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function projectState(): ProjectState {
  const sources = [...new Set(floors.map((f) => f.src))];
  return {
    categories, opacity: colourKey.opacity, showLegend,
    sources: sources.map((s) => ({ id: s.id, fileName: s.fileName, bytes: s.bytes })),
    floors: floors.map((f) => ({ name: f.name, source: sources.indexOf(f.src), page: f.page, shapes: f.shapes, labels: f.labels, scale: f.scale, legend: f.legend, rotation: f.rotation })),
  };
}

async function busy(label: string, job: () => Promise<void>) {
  const buttons = ["exportPdf", "exportCsv"].map((id) => $<HTMLButtonElement>(id));
  buttons.forEach((b) => (b.disabled = true));
  say(`${label}…`);
  try { await job(); } catch (e) { console.error(e); alert(`${label} failed: ${(e as Error).message}`); say(""); }
  finally { buttons.forEach((b) => (b.disabled = false)); }
}

$("exportPdf").addEventListener("click", () => busy("Exporting PDF", async () => {
  const input: ExportFloor[] = await Promise.all(floors.map(async (f) => {
    const page = await f.src.doc.getPage(f.page), vp = page.getViewport({ scale: 1, rotation: (page.rotate + (f.rotation ?? 0)) % 360 });
    return {
      bytes: f.src.bytes, page: f.page, pdfToView: vp.transform as Mat, rotation: f.rotation ?? 0, shapes: f.shapes,
      legend: showLegend ? (f.legend ??= defaultLegend(vp.width, vp.height)) : null,
    };
  }));
  const pdf = await exportPdf(input, categories, colourKey.opacity, JSON.stringify(toProjectFile(projectState())));
  download(pdf as Uint8Array<ArrayBuffer>, `${baseName()}-lighting.pdf`, "application/pdf");
  say(`Exported ${floors.length} floor${floors.length === 1 ? "" : "s"} to ${baseName()}-lighting.pdf (editable project included).`);
}));
$("exportCsv").addEventListener("click", () => busy("Exporting room list", async () => {
  download(roomCsv(floors, categories), `${baseName()}-rooms.csv`, "text/csv");
  say(`Saved ${baseName()}-rooms.csv.`);
}));

/** Project JSON attached to a PDF this app exported, if any. */
async function embeddedProject(src: Source): Promise<string | null> {
  const att = await src.doc.getAttachments();
  const entries: [string, { filename: string; content?: Uint8Array | null }][] = att instanceof Map ? [...att] : Object.entries(att ?? {});
  const hit = entries.find(([, a]) => a.filename === PROJECT_ATTACHMENT);
  if (!hit) return null;
  const content = hit[1].content ?? await src.doc.getAttachmentContent(hit[0]);
  return content ? new TextDecoder().decode(content) : null;
}

async function openProject(name: string, json: string) {
  if (floors.some((f) => f.shapes.length) && !confirm(`Open ${name}? The current project will be closed (export it first if needed).`)) return;
  say(`Opening ${name}…`);
  try {
    await loadProject(fromProjectFile(parseProject(json)));
    startAutosave();
    markDirty();
    say(`Opened ${name}: ${summary()}.`);
  } catch (e) {
    alert(`Could not open ${name}: ${(e as Error).message}`);
    say("");
  }
}

const summary = () => `${floors.length} floor${floors.length === 1 ? "" : "s"}, ${floors.reduce((n, f) => n + f.shapes.length, 0)} rooms`;

async function loadProject(p: ProjectState, currentIndex = 0) {
  const sources: Source[] = await Promise.all(p.sources.map(async (s) => {
    const task = loadPdf(s.bytes.slice());
    return { ...s, task, doc: await task.promise };
  }));
  for (const src of new Set(floors.map((f) => f.src))) src.task.destroy();
  floors = p.floors.map((f) => ({ name: f.name, src: sources[f.source], page: f.page, shapes: f.shapes, labels: f.labels, scale: f.scale, legend: f.legend, rotation: f.rotation }));
  categories.splice(0, categories.length, ...p.categories);
  colourKey.reload();
  colourKey.setOpacity(p.opacity);
  showLegend = p.showLegend;
  $<HTMLInputElement>("showLegend").checked = showLegend;
  current = null;
  showChrome();
  await showFloor(floors[currentIndex] ?? floors[0]);
}

// ---- autosave (this browser only) ----
let autosaveOn = false, autosaveOk = true, dirty = false, saveTimer = 0;
function startAutosave() {
  autosaveOn = true;
  $("resume").hidden = true;
}
function markDirty() {
  if (!autosaveOn) return; // not until the user resumes or starts a project: don't overwrite the saved session
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, 1500);
}
async function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    if (floors.length) await saveSession(projectState(), current ? floors.indexOf(current) : 0);
    else await clearSession();
    autosaveOk = true;
    $("saved").textContent = floors.length ? `Autosaved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  } catch (e) {
    console.error(e);
    if (autosaveOk) say(`Autosave isn't available in this browser (${(e as Error).message}). Export the PDF to keep your work.`);
    autosaveOk = false;
    $("saved").textContent = "Not autosaved";
  }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

peekSession().then((s) => {
  if (!s?.floors.length || autosaveOn) return;
  const rooms = s.floors.reduce((n, f) => n + f.shapes.length, 0);
  const when = new Date(s.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  $("resumeText").textContent = `${s.sources.map((x) => x.fileName).join(", ")}: ${s.floors.length} floor${s.floors.length === 1 ? "" : "s"}, ${rooms} rooms, saved ${when}.`;
  $("resume").hidden = false;
});
$("resumeBtn").addEventListener("click", async () => {
  say("Resuming last session…");
  try {
    const saved = await loadSession();
    if (!saved) throw new Error("nothing saved");
    await loadProject(saved.state, saved.current);
    startAutosave();
    say(`Resumed: ${summary()}.`);
  } catch (e) {
    alert(`Could not resume: ${(e as Error).message}`);
    say("");
  }
});
