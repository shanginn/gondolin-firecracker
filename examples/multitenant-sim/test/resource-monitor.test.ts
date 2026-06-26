import assert from "node:assert/strict";
import test from "node:test";

import {
  parseByteQuantity,
  parseCpuQuantity,
} from "../src/resource-monitor.ts";

test("resource monitor parses Kubernetes CPU quantities", () => {
  assert.equal(parseCpuQuantity("80"), 80_000);
  assert.equal(parseCpuQuantity("500m"), 500);
  assert.equal(parseCpuQuantity("125000000n"), 125);
  assert.equal(parseCpuQuantity("250000u"), 250);
});

test("resource monitor parses Kubernetes byte quantities", () => {
  assert.equal(parseByteQuantity("84M"), 84_000_000);
  assert.equal(parseByteQuantity("8Gi"), 8 * 1024 ** 3);
  assert.equal(parseByteQuantity("512Mi"), 512 * 1024 ** 2);
  assert.equal(parseByteQuantity("1000"), 1000);
});
