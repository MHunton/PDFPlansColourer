import { test } from "node:test";
import assert from "node:assert/strict";
import { searchRooms } from "./search.ts";

const sq: [number, number][] = [[0, 0], [1, 0], [1, 1]];
const floors = [
  { name: "Ground floor", shapes: [
    { id: "a", points: sq, roomNo: "4.3.030", name: "m staff change" },
    { id: "b", points: sq, roomNo: "4.3.301", name: "store", notes: "check emergency light" },
    { id: "c", points: sq, name: "plant room" },
  ], labels: [{ no: "4.3.030", name: "m staff change", at: [0, 0] as [number, number] }, { no: "4.3.019", name: "ips", at: [5, 5] as [number, number] }] },
  { name: "First floor", shapes: [{ id: "d", points: sq, roomNo: "5.3.030", name: "corridor" }] },
];

test("searchRooms", () => {
  const texts = (q: string) => searchRooms(floors, q).map((h) => h.text);
  assert.deepEqual(texts("4.3.030"), ["4.3.030 m staff change"]);
  assert.deepEqual(texts("4.3.0"), ["4.3.030 m staff change", "4.3.019 ips"], "prefix; traced label not repeated, untraced one included");
  assert.deepEqual(texts("EMERGENCY"), ["4.3.301 store"], "notes, case-insensitive");
  assert.deepEqual(texts("plant"), ["plant room"], "name only");
  assert.deepEqual(texts("030"), ["4.3.030 m staff change", "5.3.030 corridor"], "all floors");
  assert.equal(searchRooms(floors, "4.3.019")[0].label?.no, "4.3.019");
  assert.deepEqual(texts("  "), []);
  // a room drawn around the 4.3.019 marker (no number given) places it
  floors[0].shapes.push({ id: "e", points: [[4, 4], [6, 4], [6, 6], [4, 6]] });
  assert.deepEqual(texts("4.3.019"), []);
});
