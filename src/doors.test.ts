import { test } from "node:test";
import assert from "node:assert/strict";
import { findDoors, type Seg } from "./doors.ts";
import type { Pt } from "./coords.ts";

// A door from sample-plan.pdf (PDF pt): arc drawn as separate 2-point paths, leaf as a thin rectangle from the
// hinge (1280.5, 1284.5), wall line along y = 1284.5 with frame stubs at both jambs.
const polyline = (i0: number, pts: Pt[]): Seg[] => pts.slice(1).map((b, k) => ({ i: i0 + k, a: pts[k], b }));
const arc = polyline(100, [[1293.4, 1284.5], [1293, 1281], [1291.7, 1277.9], [1289.5, 1275.1], [1286.8, 1273], [1283.6, 1271.6], [1280.2, 1271.3]]);
const leaf = polyline(200, [[1280.8, 1284.5], [1280.8, 1271.3], [1280.2, 1271.3], [1280.2, 1284.5], [1280.8, 1284.5]]);
const frame = [...polyline(300, [[1293.4, 1284.5], [1293.4, 1286.2], [1293.8, 1286.2]]), ...polyline(310, [[1293.8, 1284.5], [1296.7, 1284.5]])];
const ptPerM = 72 / 0.0254 / 200;

test("door: hinge to closed end is the doorway; arc and leaf are marked", () => {
  const { doors, ops } = findDoors([...arc, ...leaf, ...frame], 0.4 * ptPerM, 1.6 * ptPerM);
  assert.equal(doors.length, 1);
  const { h, e } = doors[0];
  assert.ok(Math.hypot(h[0] - 1280.3, h[1] - 1284.5) < 0.6, `hinge ${h}`);
  assert.ok(Math.hypot(e[0] - 1293.4, e[1] - 1284.5) < 0.1, `closed end ${e}`);
  assert.equal(h[1], e[1], "doorway squared to the wall");
  for (const s of arc) assert.ok(ops.has(s.i), "arc op marked");
  assert.ok(ops.has(200) && ops.has(202), "leaf sides marked");
  for (const s of frame) assert.ok(!ops.has(s.i), "frame kept");
});

test("no leaf, or a straight polyline: no door", () => {
  assert.equal(findDoors(arc, 0.4 * ptPerM, 1.6 * ptPerM).doors.length, 0);
  const line = polyline(0, [[0, 0], [3, 0], [6, 0], [9, 0], [12, 0]]);
  assert.equal(findDoors(line, 0.4 * ptPerM, 1.6 * ptPerM).doors.length, 0);
});
