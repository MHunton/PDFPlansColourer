# Plan Colour-Coder

Colour-code rooms on site plan PDFs (e.g. by lighting type) and export a marked-up PDF with a legend.
Runs entirely in the browser: PDFs are never uploaded anywhere.

## Run locally

Needs Node 20.19+ (22+ recommended).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Node 22.18+)
```

Click **+ Add PDF** (or drop files on the window). You can add several PDFs at once: every page becomes a floor.
The Floors dialog suggests a name from the drawing (e.g. "Level 3"); untick pages you don't need. Floors are sorted lowest first.
Try `sample-plan.pdf` (A0, rotated) and `sample-multipage.pdf` (3 pages).
**Automatic rooms:** when a floor is added, rooms are found from the room numbers in the drawing text
(e.g. "4.3.030") and traced as editable outlines, each carrying its number and name. Click a room to select it.
Detection is deliberately conservative: only spaces closed off by walls/doors and holding a single room label are
traced. Doorways and openings up to ~3.3 m are closed along the wall line (only between wall ends, so door-frame
nibs and wall bumps don't cut a room in two), so rooms come out as wall-to-wall shapes with their door swings.
Small symbols inside a room (fire exit signs, call points, sockets, room tags) are ignored, so they don't punch holes
in it or split it. Open-plan areas shared by several labels are left for you to draw.
Labelled rooms that could not be traced show as pulsing red markers; the *Missing* button jumps to each.
Tap a marker (or choose *Draw room*) and draw the room around it: it takes the marker's number and name (all of them,
joined with "+", if you draw one room around several). A marker inside any room counts as placed.

**Find room (Ctrl+F, top of the panel):** searches room numbers, names and notes on every floor, including labels
not traced yet. Pick a result to jump to its floor, select the room and zoom to it.
Works on vector PDFs with text; scanned drawings have no text, so their rooms are drawn by hand.

**Colour key (right panel, *Key* button on phones):** *+ Add lighting type*, name it and pick a colour. Tick a type
to paint: every room you tap (or draw) gets it; *Select only* or Esc stops. Counts show rooms per type across all
floors. The *Selected room* section edits the room number, name, type and notes. *Fill opacity* keeps walls and text readable.

**Autosave:** your work (rooms, key, floors and the drawings themselves) is saved in this browser a moment after
every change. When you open the app again, *Resume* picks up where you left off. The save lives in this browser on
this device only, and clearing site data deletes it: export a PDF to keep a portable copy or to carry on elsewhere.

**Legend:** each floor shows a "Lighting key" box (tick *Show key on plan*). Drag it to move it, drag its corner to
resize it (the text scales with it).

**Save & export (bottom of the panel):**
- *Export PDF*: one PDF with every floor in floor order. Original pages are copied untouched; coloured rooms and the
  key are drawn on top as vectors. The editable project (including the original drawings) is attached to the PDF.
- *Room list (CSV)*: floor, room number, name, lighting type, notes, area in m² (from the drawing's scale), and
  labelled rooms not drawn yet. Opens in Excel.
- To carry on elsewhere: add an exported PDF with *+ Add PDF* (or drop it on the window); its rooms, key and notes
  come back editable.

**Marking rooms:** *Draw room* (D), tap each corner, then tap the first point, double-click/double-tap, press Enter or *Finish*.
Esc or *Cancel* discards; Backspace removes the last corner. Dragging pans, even while drawing.
*Select* (V): tap a room, drag its corners (each corner has a grab area bigger than its dot, so small rooms are easy to edit when zoomed in), drag a side's midpoint (or right-click an edge) to add a corner,
right-click or double-click a corner to remove it, Delete to remove the room. Right-click while drawing undoes a point. Undo/Redo (Ctrl+Z / Ctrl+Y) work per floor.

Add `?debug` to the URL to outline every PDF text item: if the boxes sit on the text at every zoom, the overlay is aligned.

## Build and deploy

```bash
npm run build      # outputs static files to dist/
npm run preview    # serve dist/ at http://localhost:4173 to check the build
```

`dist/` is a plain static site with relative paths. Upload it to any static host or sub-folder:

- **GitHub Pages** (free for public repos): push this folder to a GitHub repo, then Settings > Pages > Source:
  *GitHub Actions*. `.github/workflows/deploy.yml` tests, builds and publishes on every push to `main`, at
  `https://<user>.github.io/<repo>/`. `.gitignore` excludes `*.pdf`: never commit client drawings to a public repo.
- **Netlify**: drag `dist/` onto app.netlify.com/drop.
- **Any web server / SharePoint / S3**: copy the contents of `dist/`.

The app has no server component and no secrets, so a public URL exposes no drawings.

## Browser support

Current Chrome, Edge, Firefox, Safari (desktop and iPad). Uses the pdf.js legacy build for older Safari/iPadOS.

## Code layout

- `src/coords.ts` – PDF / view / screen coordinate conversions (single source of truth; shapes are stored in PDF user space)
- `src/pdf.ts` – pdf.js loading and region rendering
- `src/viewer.ts` – pan/zoom, low-res base render + sharp re-render of the visible area on zoom settle, SVG overlay
- `src/shapes.ts` – room shape model and per-floor undo/redo
- `src/editor.ts` – Select and Draw room tools, room/handle rendering
- `src/rooms.ts` – automatic room detection: room labels as seeds, filtered barrier renders, worker call
- `src/roomLabels.ts` – room numbers/names and drawing scale from PDF text
- `src/segment.ts`, `src/segment.worker.ts` – flood fill, doorway bridging, outline tracing
- `src/key.ts` – colour key panel: lighting types, painting, opacity, selected-room fields
- `src/search.ts` – find rooms by number, name or notes across floors
- `src/legend.ts` – colour key box: shared layout for screen and PDF
- `src/exportPdf.ts` – PDF export with pdf-lib (loaded on first export)
- `src/project.ts` – project format embedded in exported PDFs, room list CSV
- `src/autosave.ts` – autosave and resume (IndexedDB, this browser only)
- `src/floorName.ts` – guess a floor name from drawing text / file name; floor sort order
- `src/floorDialog.ts` – Floors dialog (thumbnails, names, include/remove)
- `src/main.ts` – UI wiring (adding PDFs, floor tabs, zoom buttons)
