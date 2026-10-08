import { test } from "node:test";
import assert from "node:assert/strict";
import { fixCase } from "./ocr.ts";

test("fixCase: look-alikes by context", () => {
  assert.equal(fixCase("OFFlCE"), "OFFICE");
  assert.equal(fixCase("Iockers"), "lockers");
  assert.equal(fixCase("MHL2-O47"), "MHL2-047");
  assert.equal(fixCase("6.4.O87"), "6.4.087");
  assert.equal(fixCase("C4223"), "C4223");
});
