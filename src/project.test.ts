import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBase64, parseProject, roomCsv, toBase64 } from "./project.ts";
import { legendLayout } from "./legend.ts";

test("base64 round trip, larger than one chunk", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test("roomCsv: escaping, area from scale, untraced labels", () => {
  const sq = (m: number): [number, number][] => { const s = m * 72 / 0.0254 / 200; return [[0, 0], [s, 0], [s, s], [0, s]]; };
  const csv = roomCsv([{
    name: "Ground floor", scale: 200,
    shapes: [{ id: "a", points: sq(3), roomNo: "4.3.030", name: 'store, "old"', notes: "line1\nline2", categoryId: "c1" }],
    labels: [{ no: "4.3.030", name: "store", at: [1, 1] }, { no: "4.3.019", name: "ips", at: [500, 500] }],
  }], [{ id: "c1", name: "LED panel", colour: "#000" }]);
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], "Floor,Room number,Name,Lighting type,Notes,Area (m²),Status");
  assert.equal(lines[1], 'Ground floor,4.3.030,"store, ""old""",LED panel,"line1\nline2",9.0,drawn');
  assert.equal(lines[2], "Ground floor,4.3.019,ips,,,,not drawn");
});

test("parseProject rejects other JSON", () => {
  assert.throws(() => parseProject('{"hello":1}'), /not a Plan Colour-Coder project/);
});

test("legendLayout: box fits the widest line", () => {
  const measure = (t: string, size: number) => t.length * size * 0.5;
  const L = legendLayout([{ name: "LED panel", colour: "#f00" }, { name: "Emergency lighting only", colour: "#00f" }], 10, measure);
  const widest = Math.max(...L.rows.map((r) => r.text.x + measure(r.name, 10)));
  assert.ok(L.w >= widest && L.w - widest < 10, `w ${L.w} vs text ${widest}`);
  assert.ok(L.rows[1].swatch.y + L.rows[1].swatch.h < L.h);
});
