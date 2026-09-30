import { test } from "node:test";
import assert from "node:assert/strict";
import { History, nearestEdge, pointInPolygon, polygonArea, snapshot, type Shape } from "./shapes.ts";

test("History undo/redo per floor", () => {
  const h = new History<{ shapes: Shape[] }>();
  const a = { shapes: [] as Shape[] }, b = { shapes: [] as Shape[] };
  const add = (f: typeof a, id: string) => { const before = snapshot(f.shapes); f.shapes.push({ id, points: [[0, 0], [1, 0], [1, 1]] }); h.push(f, before); };

  add(a, "1"); add(a, "2"); add(b, "x");
  assert.ok(h.undo(a));
  assert.deepEqual(a.shapes.map((s) => s.id), ["1"]);
  assert.deepEqual(b.shapes.map((s) => s.id), ["x"], "other floor untouched");
  assert.ok(h.redo(a));
  assert.deepEqual(a.shapes.map((s) => s.id), ["1", "2"]);

  // vertex edit then undo restores coordinates (snapshots are deep copies)
  const before = snapshot(a.shapes);
  a.shapes[0].points[0] = [5, 5];
  h.push(a, before);
  h.undo(a);
  assert.deepEqual(a.shapes[0].points[0], [0, 0]);

  // new edit clears redo
  add(a, "3");
  assert.equal(h.canRedo(a), false);
  h.undo(a); h.undo(a); h.undo(a);
  assert.equal(h.undo(a), false);
  assert.deepEqual(a.shapes, []);
});

test("polygon helpers", () => {
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(polygonArea(sq), 100);
  assert.equal(pointInPolygon([5, 5], sq), true);
  assert.equal(pointInPolygon([15, 5], sq), false);
  const e = nearestEdge([4, -2], sq);
  assert.deepEqual([e.i, e.at, e.dist], [0, [4, 0], 2]);
});
