import assert from "node:assert/strict";
import test from "node:test";

import { applyConfigPatch, createDefaultConfig } from "../src/config.ts";

test("multitenant sim config clamps numeric strategy knobs", () => {
  const config = createDefaultConfig({
    GONDOLIN_SIM_IMAGE: "/tmp/image",
    GONDOLIN_SIM_WORK_DIR: "/tmp/work",
  });

  const next = applyConfigPatch(config, {
    strategy: "warm-snapshot",
    targetUsers: "0",
    arrivalRatePerSec: "-1",
    maxActiveVms: "12.9",
    bootConcurrency: "3",
    hotIdleTtlMs: "-10",
    warmSnapshotTtlMs: "1000",
    vmStartTimeoutMs: "0",
    networkEnabled: false,
  });

  assert.equal(next.strategy, "warm-snapshot");
  assert.equal(next.targetUsers, 1);
  assert.equal(next.arrivalRatePerSec, 0);
  assert.equal(next.maxActiveVms, 12);
  assert.equal(next.bootConcurrency, 3);
  assert.equal(next.hotIdleTtlMs, 0);
  assert.equal(next.warmSnapshotTtlMs, 1000);
  assert.equal(next.vmStartTimeoutMs, 1);
  assert.equal(next.networkEnabled, false);
});
