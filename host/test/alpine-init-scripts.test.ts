import assert from "node:assert/strict";
import test from "node:test";

import { ROOTFS_INIT_SCRIPT } from "../src/alpine/init-scripts.ts";

test("rootfs init uses current uv system certificates environment variable", () => {
  assert.match(ROOTFS_INIT_SCRIPT, /export UV_SYSTEM_CERTS=true/);
  assert.doesNotMatch(ROOTFS_INIT_SCRIPT, /UV_NATIVE_TLS/);
});
