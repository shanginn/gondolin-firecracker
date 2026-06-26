import assert from "node:assert/strict";
import test from "node:test";

import type { SessionBackend } from "../src/backends.ts";
import { readSimulatorConfig } from "../src/config.ts";
import { MultiTenantSimulator } from "../src/simulator.ts";

const fakeBackend: SessionBackend = {
  kind: "fake",
  async start(user) {
    return {
      id: `fake-${user.id}`,
      async sendMessage() {
        return { latencyMs: 5, summary: "ok", hostPid: null };
      },
      async close() {},
    };
  },
};

test("runtime settings are clamped to configured caps", () => {
  const config = readSimulatorConfig({
    SIM_MAX_ACTIVE_USERS: "4",
    SIM_MAX_ACTIVE_VMS: "2",
    SIM_MAX_SPAWN_RATE_PER_MINUTE: "9",
    SIM_MAX_TEMPO: "4",
  });
  const sim = new MultiTenantSimulator(config, fakeBackend, () => 1000);

  const settings = sim.updateSettings({
    targetUsers: 100,
    maxActiveVms: 100,
    spawnRatePerMinute: 100,
    tempo: 100,
  });

  assert.equal(settings.targetUsers, 4);
  assert.equal(settings.maxActiveVms, 2);
  assert.equal(settings.spawnRatePerMinute, 9);
  assert.equal(settings.tempo, 4);
});

test("manual burst cannot exceed active user cap", async () => {
  const config = readSimulatorConfig({
    SIM_MAX_ACTIVE_USERS: "3",
    SIM_MAX_ACTIVE_VMS: "1",
    SIM_SEED: "burst-test",
  });
  const sim = new MultiTenantSimulator(config, fakeBackend, () => 1000);

  await sim.action("burst", 99);
  const snapshot = sim.snapshot(1000);

  assert.equal(snapshot.gauges.activeUsers, 3);
});
