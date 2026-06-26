import assert from "node:assert/strict";
import test from "node:test";

import { readSimulatorConfig } from "../src/config.ts";

test("config clamps dashboard-facing ceilings", () => {
  const config = readSimulatorConfig({
    SIM_BACKEND: "gondolin",
    SIM_MAX_ACTIVE_USERS: "10",
    SIM_MAX_ACTIVE_VMS: "99",
    SIM_TARGET_USERS: "42",
    SIM_MAX_SPAWN_RATE_PER_MINUTE: "5",
    SIM_SPAWN_RATE_PER_MINUTE: "500",
    SIM_MAX_TEMPO: "3",
    SIM_TEMPO: "10",
    SIM_VM_IMAGE: "alpine-tiny-firecracker:0.1.0",
    SIM_VM_NET_ENABLED: "true",
  });

  assert.equal(config.backend, "gondolin");
  assert.equal(config.maxActiveUsers, 10);
  assert.equal(config.maxActiveVms, 10);
  assert.equal(config.targetUsers, 10);
  assert.equal(config.maxSpawnRatePerMinute, 5);
  assert.equal(config.spawnRatePerMinute, 5);
  assert.equal(config.maxTempo, 3);
  assert.equal(config.tempo, 3);
  assert.equal(config.vmImage, "alpine-tiny-firecracker:0.1.0");
  assert.equal(config.vmNetEnabled, true);
});

test("config defaults to paused mock mode", () => {
  const config = readSimulatorConfig({});

  assert.equal(config.backend, "mock");
  assert.equal(config.pausedOnStart, true);
  assert.equal(config.port, 8080);
  assert.equal(config.vmImage, null);
  assert.equal(config.vmNetEnabled, false);
});
