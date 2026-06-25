import assert from "node:assert/strict";
import test from "node:test";

import {
  INITRAMFS_INIT_SCRIPT,
  ROOTFS_INIT_SCRIPT,
} from "../src/alpine/init-scripts.ts";

test("rootfs init uses current uv system certificates environment variable", () => {
  assert.match(ROOTFS_INIT_SCRIPT, /export UV_SYSTEM_CERTS=true/);
  assert.doesNotMatch(ROOTFS_INIT_SCRIPT, /UV_NATIVE_TLS/);
});

test("init scripts configure mediated egress DNS and TLS trust", () => {
  assert.match(INITRAMFS_INIT_SCRIPT, /nameserver 192\.168\.127\.1/);
  assert.match(ROOTFS_INIT_SCRIPT, /nameserver 192\.168\.127\.1/);
  assert.match(ROOTFS_INIT_SCRIPT, /gondolin-ca-certificates\.crt/);
  assert.match(ROOTFS_INIT_SCRIPT, /NODE_EXTRA_CA_CERTS/);
});
