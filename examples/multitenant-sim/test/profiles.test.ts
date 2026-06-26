import assert from "node:assert/strict";
import test from "node:test";

import { createUserPlan, nextDelayMs } from "../src/profiles.ts";
import { createRng } from "../src/rng.ts";

test("profile planning is deterministic for a seed", () => {
  const a = createUserPlan(createRng("same-seed"), 1000, 60_000);
  const b = createUserPlan(createRng("same-seed"), 1000, 60_000);

  assert.equal(a.profile.name, b.profile.name);
  assert.equal(a.expiresAt, b.expiresAt);
  assert.equal(a.messageBudget, b.messageBudget);
});

test("profile delays respect tempo floor", () => {
  const rng = createRng("tempo");
  const plan = createUserPlan(rng, 0, 60_000);
  const delay = nextDelayMs(rng, plan.profile, 1000);

  assert.ok(delay >= 100);
});
