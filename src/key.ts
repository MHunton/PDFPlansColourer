import type { Editor } from "./editor";
import { newId, type Category, type Shape } from "./shapes";

// Distinct, and clear of the colours fire plans already use (red, green, cyan).
const PALETTE = ["#2563eb", "#f59e0b", "#7c3aed", "#db2777", "#65a30d", "#ea580c", "#4f46e5", "#0f766e", "#a16207", "#64748b"];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Colour key side panel: lighting types (name + colour, paint radio, room count), fill opacity, and the selected
 * room's number / name / type. `categories` is the project's list, edited in place. Inputs are only rebuilt when
 * the list itself changes, so typing in them never loses focus.
 */
export class KeyPanel {
  constructor(private readonly categories: Category[], private readonly editor: Editor, private readonly allShapes: () => Shape[]) {
    editor.categories = categories;
    $("addCategory").addEventListener("click", () => this.add());
    $("brushNone").addEventListener("change", () => this.setBrush(null));
    const opacity = $<HTMLInputElement>("opacity");
    opacity.addEventListener("input", () => this.setOpacity(Number(opacity.value) / 100));
    $("roomNo").addEventListener("change", (e) => editor.update({ roomNo: (e.target as HTMLInputElement).value.trim() }));
    $("roomName").addEventListener("change", (e) => editor.update({ name: (e.target as HTMLInputElement).value.trim() }));
    $("roomCat").addEventListener("change", (e) => editor.update({ categoryId: (e.target as HTMLSelectElement).value }));
    $("roomNotes").addEventListener("change", (e) => editor.update({ notes: (e.target as HTMLTextAreaElement).value.trim() }));
    this.renderList();
  }

  get opacity(): number { return Number($<HTMLInputElement>("opacity").value) / 100; }

  setOpacity(v: number): void {
    const pct = Math.round(v * 100);
    $<HTMLInputElement>("opacity").value = String(pct);
    $("viewer").style.setProperty("--room-opacity", String(v));
    $("opacityVal").textContent = `${pct}%`;
    this.editor.onChange?.(); // legend swatches
  }

  /** After the category list was replaced (project opened). */
  reload(): void {
    this.editor.brush = null;
    this.renderList();
  }

  setBrush(id: string | null): void {
    this.editor.brush = id;
    this.refresh();
    this.editor.onChange?.(); // hint text
  }

  /** Counts, radio state and selected-room fields; cheap, call on every editor change. */
  refresh(): void {
    const counts = new Map<string, number>();
    for (const s of this.allShapes()) if (s.categoryId) counts.set(s.categoryId, (counts.get(s.categoryId) ?? 0) + 1);
    for (const li of $("categories").children) {
      const id = (li as HTMLElement).dataset.id!;
      li.querySelector(".count")!.textContent = String(counts.get(id) ?? 0);
      li.querySelector<HTMLInputElement>("[type=radio]")!.checked = this.editor.brush === id;
    }
    $<HTMLInputElement>("brushNone").checked = this.editor.brush === null;

    const sel = this.editor.selected;
    $("roomPanel").hidden = !sel;
    if (!sel) return;
    const setIfIdle = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, v: string) => { if (document.activeElement !== el) el.value = v; };
    setIfIdle($("roomNo"), sel.roomNo ?? "");
    setIfIdle($("roomName"), sel.name ?? "");
    setIfIdle($("roomCat"), sel.categoryId ?? "");
    setIfIdle($("roomNotes"), sel.notes ?? "");
    $("roomDup").hidden = !sel.roomNo || !this.editor.floorShapes.some((s) => s !== sel && s.roomNo === sel.roomNo);
  }

  private add(): void {
    const used = new Set(this.categories.map((c) => c.colour));
    const colour = PALETTE.find((c) => !used.has(c)) ?? PALETTE[this.categories.length % PALETTE.length];
    const cat = { id: newId(), name: `Lighting type ${this.categories.length + 1}`, colour };
    this.categories.push(cat);
    this.renderList();
    this.setBrush(cat.id); // ready to paint with it
    const input = $("categories").lastElementChild?.querySelector<HTMLInputElement>(".cat-name");
    input?.focus();
    input?.select();
  }

  private remove(cat: Category): void {
    const users = this.allShapes().filter((s) => s.categoryId === cat.id);
    if (users.length && !confirm(`Delete "${cat.name}"? ${users.length} room${users.length === 1 ? "" : "s"} will lose their colour.`)) return;
    users.forEach((s) => delete s.categoryId); // ponytail: not undoable; the confirm is the safety net
    this.categories.splice(this.categories.indexOf(cat), 1);
    if (this.editor.brush === cat.id) this.editor.brush = null;
    this.renderList();
    this.editor.refresh();
  }

  private renderList(): void {
    $("categories").replaceChildren(...this.categories.map((cat) => {
      const li = document.createElement("li");
      li.className = "cat";
      li.dataset.id = cat.id;
      li.innerHTML = `
        <input type="radio" name="brush" aria-label="Paint rooms with this type">
        <input type="color" aria-label="Colour">
        <input type="text" class="cat-name" aria-label="Name">
        <span class="count" title="Rooms with this type, all floors">0</span>
        <button class="del" aria-label="Delete type" title="Delete type">×</button>`;
      const [radio, colour, name] = li.querySelectorAll("input");
      colour.value = cat.colour;
      name.value = cat.name;
      radio.addEventListener("change", () => this.setBrush(cat.id));
      li.addEventListener("click", (e) => { if (e.target === li || (e.target as HTMLElement).classList.contains("count")) this.setBrush(cat.id); });
      colour.addEventListener("input", () => { cat.colour = colour.value; this.editor.refresh(); });
      name.addEventListener("input", () => { cat.name = name.value; this.renderOptions(); this.editor.onChange?.(); });
      name.addEventListener("change", () => { cat.name = name.value.trim() || "Unnamed type"; name.value = cat.name; this.renderOptions(); });
      li.querySelector(".del")!.addEventListener("click", () => this.remove(cat));
      return li;
    }));
    $("keyEmpty").hidden = this.categories.length > 0;
    this.renderOptions();
    this.refresh();
  }

  private renderOptions(): void {
    $("roomCat").replaceChildren(new Option("No type", ""), ...this.categories.map((c) => new Option(c.name, c.id)));
    const sel = this.editor.selected;
    $<HTMLSelectElement>("roomCat").value = sel?.categoryId ?? "";
  }
}
