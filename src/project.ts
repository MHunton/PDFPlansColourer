// Project state (autosave), project file (embedded in exported PDFs) and the room list CSV.
import type { LegendState } from "./legend";
import type { RoomLabel } from "./roomLabels";
import { newId, polygonArea, untracedLabels, type Category, type Shape } from "./shapes.ts"; // .ts: also used by node --test

export const PROJECT_ATTACHMENT = "plan-colour-coder-project.json";

export interface ProjectFloor {
  name: string; source: number; page: number; shapes: Shape[];
  labels?: RoomLabel[]; scale?: number | null; legend?: LegendState;
}
export interface ProjectFile {
  app: "plan-colour-coder"; version: 1;
  categories: Category[]; opacity: number; showLegend: boolean;
  sources: { fileName: string; data: string }[]; // original PDFs, base64: the file is self-contained
  floors: ProjectFloor[];
}

/** In-memory project with the original PDFs as bytes (autosave stores this). */
export interface ProjectState {
  categories: Category[]; opacity: number; showLegend: boolean;
  sources: { id: string; fileName: string; bytes: Uint8Array }[];
  floors: ProjectFloor[];
}

/** File form, embedded in exported PDFs: self-contained JSON (PDFs as base64). */
export const toProjectFile = ({ sources, ...s }: ProjectState): ProjectFile =>
  ({ app: "plan-colour-coder", version: 1, ...s, sources: sources.map((x) => ({ fileName: x.fileName, data: toBase64(x.bytes) })) });
export const fromProjectFile = ({ app: _, version: __, sources, ...p }: ProjectFile): ProjectState =>
  ({ ...p, sources: sources.map((x) => ({ id: newId(), fileName: x.fileName, bytes: fromBase64(x.data) })) });

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Parse and sanity-check a project file; throws a readable error for anything else. */
export function parseProject(text: string): ProjectFile {
  const p = JSON.parse(text);
  if (p?.app !== "plan-colour-coder" || !Array.isArray(p.floors) || !Array.isArray(p.sources)) throw new Error("not a Plan Colour-Coder project");
  if (p.version !== 1) throw new Error(`project version ${p.version} is newer than this app`);
  return p;
}

interface CsvFloor { name: string; shapes: Shape[]; labels?: RoomLabel[]; scale?: number | null }

/** Room list: one row per room, plus labelled rooms not drawn yet. Area from the drawing scale, if known. */
export function roomCsv(floors: CsvFloor[], categories: Category[]): string {
  const cell = (v: string | number) => { const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows: (string | number)[][] = [["Floor", "Room number", "Name", "Lighting type", "Notes", "Area (m²)", "Status"]];
  for (const f of floors) {
    const ptPerM = f.scale ? 72 / 0.0254 / f.scale : 0;
    for (const s of f.shapes) {
      const area = ptPerM ? (polygonArea(s.points) / ptPerM ** 2).toFixed(1) : "";
      rows.push([f.name, s.roomNo ?? "", s.name ?? "", categories.find((c) => c.id === s.categoryId)?.name ?? "", s.notes ?? "", area, "drawn"]);
    }
    for (const l of untracedLabels(f.shapes, f.labels ?? [])) rows.push([f.name, l.no, l.name, "", "", "", "not drawn"]);
  }
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"; // BOM: Excel reads UTF-8 (m², names)
}
