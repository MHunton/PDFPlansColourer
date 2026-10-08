import { test } from "node:test";
import assert from "node:assert/strict";
import { drawingScale, roomLabels, type TextItem } from "./roomLabels.ts";

// Text as in sample-plan.pdf: rotated 90° (dir = +y, up = -x), number above name.
const t = (str: string, x: number, y: number, width = 19): TextItem => ({ str, transform: [0, 5.9, -5.9, 0, x, y], width, height: 5.9 });

test("room numbers by dominant pattern, name from the line below", () => {
  const items = [
    t("4.3.030", 990, 1426), t("m staff change", 997, 1418, 40),
    t("4.3.031", 1100, 1500), t("f staff change", 1107, 1492, 38),
    t("4.3.002a", 1200, 1600), t("sw", 1207, 1605, 6),
    t("4.3.140", 1300, 1700), t("corridor", 1307, 1695, 20),
    t("FES.Z4.L3.13", 800, 800, 40), t("FES.Z4.L3.12", 800, 900, 40),
    t("2400", 10, 10), t("1200", 20, 10), t("3000", 30, 10),
  ];
  const labels = roomLabels(items);
  assert.deepEqual(labels.map((l) => [l.no, l.name]), [["4.3.030", "m staff change"], ["4.3.031", "f staff change"], ["4.3.002a", "sw"], ["4.3.140", "corridor"]]);
  // centre of "4.3.030": x = 990 - 5.9/2, y = 1426 + 19/2
  assert.deepEqual(labels[0].at.map((v) => Math.round(v * 10) / 10), [987.1, 1435.5]);
});

test("second numbering scheme, codes printed with spaces, names over two lines, areas aren't names", () => {
  const items: TextItem[] = [];
  for (let k = 0; k < 12; k++) items.push(t(`4.3.0${10 + k}`, 100 * k, 0), t("office", 100 * k + 7, 0, 15), t("12.50 m²", 100 * k + 14, 0, 18));
  for (let k = 0; k < 10; k++) items.push(t(`D 3 2${10 + k}`, 100 * k, 500), t("STAFF", 100 * k + 7, 500, 15), t("LOUNGE", 100 * k + 14, 500, 18));
  const labels = roomLabels(items);
  assert.equal(labels.length, 22);
  assert.deepEqual([labels[0].no, labels[0].name], ["4.3.010", "office"]);
  assert.deepEqual([labels[12].no, labels[12].name], ["D3210", "STAFF LOUNGE"]);
});

test("drawingScale", () => {
  assert.equal(drawingScale("Scale 1 : 200 … Level 3 - Fire Strategy 1 : 200 … detail 1:20"), 200);
  assert.equal(drawingScale("no scale here"), null);
});
