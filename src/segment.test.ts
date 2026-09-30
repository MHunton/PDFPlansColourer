import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, segment } from "./segment.ts";

// 200x100 px plan: outer walls, a dividing wall at x=100..102 with a 16px doorway (y 40..55).
// A door hinged at (103,40) swings into the right room: leaf along y=40 to x=119, arc back to (103,56).
// Drawn 50px in from the image edge, like a real sheet: the open area around the building is "outside".
const O = 50, w = 220 + 2 * O, h = 120 + 2 * O;
const at = (x: number, y: number) => (y + O) * w + x + O;
const seeds = (...p: number[]) => new Float32Array(p.map((v) => v + O));
function plan(withDividerGap = true) {
  const walls = new Uint8Array(w * h);
  const rect = (x0: number, y0: number, x1: number, y1: number, m = walls) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[at(x, y)] = 1; };
  rect(5, 5, 205, 7); rect(5, 103, 205, 105); rect(5, 5, 7, 105); rect(203, 5, 205, 105);
  rect(100, 5, 102, 105);
  if (withDividerGap) for (let y = 40; y <= 55; y++) for (let x = 100; x <= 102; x++) walls[at(x, y)] = 0;
  const lines = walls.slice();
  rect(103, 40, 119, 40, lines); // door leaf
  for (let a = 0; a <= 90; a += 0.5) { // door arc, thin
    const x = Math.round(103 + 16 * Math.cos((a * Math.PI) / 180)), y = Math.round(40 + 16 * Math.sin((a * Math.PI) / 180));
    lines[at(x, y)] = 1;
  }
  return { walls, lines };
}

const area = (p: number[]) => { let s = 0; for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length; s += p[i] * p[j + 1] - p[j] * p[i + 1]; } return Math.abs(s) / 2; };

test("two rooms split at the doorway; door swing stays in its room", () => {
  const { walls, lines } = plan();
  const rooms = segment({ w, h, walls, lines, seeds: seeds(50, 50, 150, 70), closeR: 9, sealR: 30, minArea: 50, maxArea: 20000 });
  assert.equal(rooms.length, 2);
  const [left, right] = [...rooms].sort((a, b) => a.seeds[0] - b.seeds[0]);
  assert.deepEqual(left.seeds, [0]);
  assert.deepEqual(right.seeds, [1]);
  // interiors: left 92x95, right 100x95 (swing included, no bite)
  assert.ok(Math.abs(area(left.points) - 92 * 95) / (92 * 95) < 0.04, `left area ${area(left.points)}`);
  assert.ok(Math.abs(area(right.points) - 100 * 95) / (100 * 95) < 0.04, `right area ${area(right.points)}`);
  assert.ok(right.points.length / 2 <= 8, `right outline simplified to ${right.points.length / 2} corners`);
});

test("doorway wider than the closing: the door arc still separates the rooms", () => {
  const { walls, lines } = plan();
  const rooms = segment({ w, h, walls, lines, seeds: seeds(50, 50, 150, 70), closeR: 3, sealR: 30, minArea: 50, maxArea: 20000 });
  assert.equal(rooms.length, 2);
  const left = rooms.find((r) => r.seeds[0] === 0)!;
  assert.ok(Math.abs(area(left.points) - 92 * 95) / (92 * 95) < 0.06, `left area ${area(left.points)}`);
});

test("narrow room filled by the closing falls back to the lines version", () => {
  const { walls, lines } = plan(false); // no doorway
  const rooms = segment({ w, h, walls, lines, seeds: seeds(50, 50, 150, 70), closeR: 60, sealR: 90, minArea: 50, maxArea: 20000 });
  assert.equal(rooms.length, 2, "closing fills both rooms entirely, lines version still finds them");
});

test("two labels sharing one space (wide opening, no door) are left for the user", () => {
  const { walls } = plan();
  for (let y = 30; y <= 70; y++) for (let x = 100; x <= 102; x++) walls[at(x, y)] = 0; // 41px opening, no door
  const rooms = segment({ w, h, walls, lines: walls.slice(), seeds: seeds(50, 50, 150, 70), closeR: 5, sealR: 30, minArea: 50, maxArea: 40000 });
  assert.equal(rooms.length, 0);
});

test("an entrance wider than a door doesn't let the room escape outside", () => {
  const { walls, lines } = plan();
  for (let y = 40; y <= 70; y++) for (let x = 5; x <= 7; x++) walls[at(x, y)] = lines[at(x, y)] = 0; // 31px entrance, left wall
  const rooms = segment({ w, h, walls, lines, seeds: seeds(50, 50, 150, 70), closeR: 9, sealR: 30, minArea: 50, maxArea: 40000 });
  const left = rooms.find((r) => r.seeds[0] === 0);
  assert.ok(left, "room found (not rejected as leaking to the page edge)");
  assert.ok(area(left.points) < 92 * 95 * 1.1, `left area ${area(left.points)} stays inside`);
});

test("double-door-wide doorway: the lines-version room grows back over its door swing", () => {
  const { walls, lines } = plan(); // 16px doorway; closeR 5 bridges 11px (walls version leaks), 2*closeR bridges 21px
  const rooms = segment({ w, h, walls, lines, seeds: seeds(50, 50, 150, 70), closeR: 5, sealR: 30, minArea: 50, maxArea: 40000 });
  const right = rooms.find((r) => r.seeds[0] === 1)!;
  assert.ok(Math.abs(area(right.points) - 100 * 95) / (100 * 95) < 0.04, `right area ${area(right.points)}: a rectangle, no bite`);
  assert.ok(right.points.length / 2 <= 8, `${right.points.length / 2} corners`);
});

test("bridge closes doorways but not narrow rooms", () => {
  // 40x30: horizontal wall y=10..11 with a 6px doorway (x 10..15); a narrow room between vertical walls x=25 and x=31.
  const W = 40, H = 30, m = new Uint8Array(W * H);
  for (let x = 0; x < 22; x++) if (x < 10 || x > 15) m[10 * W + x] = m[11 * W + x] = 1;
  for (let y = 0; y < H; y++) m[y * W + 25] = m[y * W + 31] = 1;
  const out = bridge(m, W, H, 8, 3, 4);
  assert.equal(out[10 * W + 12], 1, "doorway bridged");
  assert.equal(out[5 * W + 28], 0, "narrow room (5px wide, long walls) left open");
  assert.equal(out[20 * W + 12], 0, "floor below the wall untouched");
});

test("bridge ignores door-frame nibs (no false wall across the room)", () => {
  // Room 20 wide x 7 tall between walls y=0 and y=8; a 1x2 nib sticks up from the bottom wall at x=10.
  const W = 22, H = 9, m = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) m[x] = m[8 * W + x] = 1;
  m[7 * W + 10] = m[6 * W + 10] = 1;
  const out = bridge(m, W, H, 8, 3, 4);
  assert.equal(out[3 * W + 10], 0, "nib not joined to the top wall");
});
