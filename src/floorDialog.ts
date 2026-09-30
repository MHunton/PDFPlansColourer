import { guessFloorName } from "./floorName";
import { renderRegion, type PDFDocumentLoadingTask } from "./pdf";
import type { LegendState } from "./legend";
import type { RoomLabel } from "./roomLabels";
import type { Shape } from "./shapes";

export interface Source {
  id: string;       // stable per file, for autosave
  fileName: string;
  bytes: Uint8Array; // original file, kept for export
  task: PDFDocumentLoadingTask;
  doc: Awaited<PDFDocumentLoadingTask["promise"]>;
}
/**
 * `labels`/`scale`: room labels and drawing scale (e.g. 200 for 1:200) found by room detection.
 * `legend`: where the colour key sits on this floor (view pt).
 */
export interface Floor {
  name: string; src: Source; page: number; shapes: Shape[];
  labels?: RoomLabel[]; scale?: number | null; legend?: LegendState;
}

const THUMB = 120; // CSS px, longest side

/**
 * Floors dialog: every floor gets a thumbnail, a name and an Include box. New floors are pre-named from the drawing.
 * Resolves with the included floors (names applied), or null if cancelled. Floors are only mutated on "Done".
 */
export function editFloors(rows: Floor[], fresh: Set<Floor>): Promise<Floor[] | null> {
  const dlg = document.getElementById("floorDialog") as HTMLDialogElement;
  const items = rows.map((floor) => {
    const li = document.createElement("li");
    li.className = "floor-row";
    li.innerHTML = `
      <canvas class="thumb"></canvas>
      <div class="meta">
        <input list="floorNames" required placeholder="e.g. Ground floor" aria-label="Floor name">
        <span class="muted"></span>
        <span class="warn" hidden></span>
      </div>
      <label class="include"><input type="checkbox" checked> Include</label>`;
    const [name, include] = li.querySelectorAll("input");
    name.value = floor.name;
    li.querySelector(".muted")!.textContent = `${floor.src.fileName} · page ${floor.page} of ${floor.src.doc.numPages}`;
    include.addEventListener("change", () => {
      name.disabled = !include.checked; // disabled inputs skip `required` validation
      li.classList.toggle("excluded", !include.checked);
      const warn = li.querySelector<HTMLElement>(".warn")!, n = floor.shapes.length;
      warn.hidden = include.checked || !n;
      warn.textContent = `${n} marked room${n === 1 ? "" : "s"} on this floor will be deleted.`;
      checkDuplicates();
    });
    name.addEventListener("input", checkDuplicates);
    return { floor, li, name, include, canvas: li.querySelector("canvas")! };
  });

  function checkDuplicates() {
    const seen = new Set<string>();
    for (const { name } of items) {
      const key = name.value.trim().toLowerCase();
      name.setCustomValidity(!name.disabled && key && seen.has(key) ? "Another floor already has this name." : "");
      if (!name.disabled) seen.add(key);
    }
  }

  dlg.querySelector("ol")!.replaceChildren(...items.map((i) => i.li));
  dlg.returnValue = "";
  dlg.showModal();
  (items.find((i) => fresh.has(i.floor)) ?? items[0])?.name.focus();

  // Thumbnails and name guesses, one page at a time so the dialog stays responsive.
  (async () => {
    for (const it of items) {
      if (!dlg.open) return;
      const page = await it.floor.src.doc.getPage(it.floor.page);
      if (fresh.has(it.floor) && !it.name.value) {
        const text = (await page.getTextContent()).items.map((t) => ("str" in t ? t.str : "")).join(" ");
        if (!it.name.value) it.name.value = guessFloorName(text, it.floor.src.fileName);
        checkDuplicates();
      }
      const vp = page.getViewport({ scale: 1 });
      const s = THUMB / Math.max(vp.width, vp.height);
      it.canvas.style.width = `${vp.width * s}px`;
      it.canvas.style.height = `${vp.height * s}px`;
      await renderRegion(page, it.canvas, s * devicePixelRatio, 0, 0, vp.width, vp.height).done;
    }
  })().catch(console.error);

  // submit/cancel fire synchronously; `close` is queued and Chrome can hold it back while rendering is throttled.
  return new Promise((resolve) => {
    dlg.querySelector("form")!.onsubmit = (e) => {
      if ((e.submitter as HTMLButtonElement | null)?.value !== "ok") return resolve(null);
      resolve(items.filter((i) => i.include.checked).map((i) => ((i.floor.name = i.name.value.trim()), i.floor)));
    };
    dlg.oncancel = () => resolve(null); // Esc
  });
}
