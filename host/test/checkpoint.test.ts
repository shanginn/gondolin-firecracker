import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VmCheckpoint, type VmCheckpointData } from "../src/checkpoint.ts";
import { VM } from "../src/vm/core.ts";
import {
  scheduleForceExit,
  shouldSkipVmTests,
} from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 120000);

test.after(() => {
  scheduleForceExit();
});

function writeCheckpointTrailer(
  checkpointPath: string,
  overrides: Partial<VmCheckpointData> = {},
): VmCheckpoint {
  fs.writeFileSync(checkpointPath, "raw-disk");
  VmCheckpoint.writeTrailer(checkpointPath, {
    version: 1,
    name: path.basename(checkpointPath, path.extname(checkpointPath)),
    createdAt: "2026-03-01T00:00:00.000Z",
    diskFile: path.basename(checkpointPath),
    guestAssetBuildId: "15e98966-a559-55ee-8d57-9f4c3f0346c7",
    snapshotKind: "disk",
    diskFormat: "raw",
    createdWithVmm: "firecracker",
    compatibleVmm: ["firecracker"],
    ...overrides,
  });
  return VmCheckpoint.load(checkpointPath);
}

test(
  "disk checkpoints can be resumed from raw files",
  { skip: skipVmTests, timeout: timeoutMs },
  async () => {
    const checkpointPath = path.join(
      os.tmpdir(),
      `gondolin-checkpoint-${Date.now()}.raw`,
    );

    let vm: VM | null = null;
    let resumed: VM | null = null;
    try {
      vm = await VM.create({
        startTimeoutMs: timeoutMs,
        rootfs: { mode: "cow" },
        sandbox: { console: "none" },
      });
      await vm.start();
      await vm.exec("echo checkpoint-ok > /etc/checkpoint-smoke.txt");

      const checkpoint = await vm.checkpoint(checkpointPath);
      vm = null;

      const metadata = checkpoint.toJSON();
      assert.equal(metadata.diskFormat, "raw");
      assert.equal(metadata.createdWithVmm, "firecracker");
      assert.deepEqual(metadata.compatibleVmm, ["firecracker"]);

      resumed = await checkpoint.resume<VM>({
        startTimeoutMs: timeoutMs,
        sandbox: { console: "none" },
      });
      await resumed.start();

      const read = await resumed.exec("cat /etc/checkpoint-smoke.txt");
      assert.equal(read.stdout.trim(), "checkpoint-ok");
    } finally {
      await resumed?.close();
      await vm?.close();
      fs.rmSync(checkpointPath, { force: true });
    }
  },
);

test("checkpoint resume rejects incompatible metadata", async () => {
  const checkpointPath = path.join(
    os.tmpdir(),
    `gondolin-incompatible-checkpoint-${Date.now()}.raw`,
  );

  try {
    const checkpoint = writeCheckpointTrailer(checkpointPath, {
      compatibleVmm: [],
      createdWithVmm: "removed" as any,
    });

    await assert.rejects(
      () => checkpoint.resume(),
      /checkpoint is not compatible with Firecracker/,
    );
  } finally {
    fs.rmSync(checkpointPath, { force: true });
  }
});

test("checkpoint load rejects missing raw file", () => {
  assert.throws(
    () =>
      VmCheckpoint.load(
        path.join(os.tmpdir(), "gondolin-missing-checkpoint.raw"),
      ),
    /ENOENT/,
  );
});
