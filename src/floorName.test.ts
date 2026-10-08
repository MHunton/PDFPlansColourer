import { test } from "node:test";
import assert from "node:assert/strict";
import { floorRank, guessFloorName } from "./floorName.ts";

test("guessFloorName", () => {
  // sample-plan.pdf title block / view title / schedules
  assert.equal(guessFloorName("Level 3 Fire Strategy Plan … Level 3 - Fire Strategy … Schedule - Level 3 … refer to Level 2"), "Level 3");
  assert.equal(guessFloorName("GROUND FLOOR PLAN"), "Ground floor");
  assert.equal(guessFloorName("LOWER GROUND FLOOR"), "Lower ground floor");
  assert.equal(guessFloorName("ROOF PLAN"), "Roof");
  assert.equal(guessFloorName("no hint", "Block_A-First-Floor.pdf"), "First floor");
  assert.equal(guessFloorName("room 4.3.030", "Drawing-03.pdf"), "");
  assert.equal(guessFloorName("", "Phase 2 L4.pdf"), "Level 4");
  assert.equal(guessFloorName("", "PL4_plan.pdf"), "");
});

test("floorRank sorts bottom to top, unknown last in original order", () => {
  const names = ["Roof", "Mystery A", "First floor", "Basement", "Level 2", "Ground floor", "Mystery B", "Lower ground floor"];
  const sorted = [...names].sort((a, b) => floorRank(a) - floorRank(b));
  assert.deepEqual(sorted, ["Basement", "Lower ground floor", "Ground floor", "First floor", "Level 2", "Roof", "Mystery A", "Mystery B"]);
});
