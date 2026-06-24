import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VirtioBridge } from "../src/sandbox/server-transport.ts";

async function waitForSocket(socketPath: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() <= deadline) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`socket was not created: ${socketPath}`);
}

test("VirtioBridge: disconnect removes socket file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-bridge-test-"));
  const socketPath = path.join(dir, "bridge.sock");
  const bridge = new VirtioBridge(socketPath);

  try {
    bridge.connect();
    await waitForSocket(socketPath);
    await bridge.disconnect();
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    await bridge.disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
