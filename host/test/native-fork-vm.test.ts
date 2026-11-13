import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VM, VmCheckpoint, nativeMounts } from "../src/index.ts";
import { shouldSkipVmTests } from "./helpers/vm-fixture.ts";

const backend = process.env.GONDOLIN_VMM;
const skip =
  shouldSkipVmTests() || (backend !== "vfkit" && backend !== "firecracker");

test("native raw disk checkpoint resumes privately with startup timings", {
  skip,
  timeout: 120000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-raw-roundtrip-"));
  const vms: VM[] = [];
  t.after(async () => {
    for (const vm of vms) await vm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const options = {
    sandbox: { vmm: backend as "vfkit" | "firecracker", netEnabled: false },
    rootfs: { mode: "cow" as const },
  };
  const vm = await VM.create(options);
  vms.push(vm);
  assert.equal(
    (await vm.exec("printf original >/etc/checkpoint-fork; sync")).exitCode,
    0,
  );
  assert.ok(vm.getStartupTimings().some((entry) => entry.name === "vfs ready"));
  const checkpoint = await vm.checkpoint(path.join(dir, "disk.raw"));
  assert.equal(checkpoint.toJSON().diskFormat, "raw");
  assert.deepEqual(checkpoint.toJSON().compatibleVmm, [backend]);
  const loaded = VmCheckpoint.load(checkpoint.path);
  const resumed = await loaded.resume<VM>();
  vms.push(resumed);
  assert.equal(
    (await resumed.exec("cat /etc/checkpoint-fork")).stdout,
    "original",
  );
  assert.equal(
    (await resumed.exec("printf changed >/etc/checkpoint-fork; sync")).exitCode,
    0,
  );
  await resumed.close();
  const second = await loaded.resume<VM>();
  vms.push(second);
  assert.equal(
    (await second.exec("cat /etc/checkpoint-fork")).stdout,
    "original",
  );
});

test("native Firecracker snapshot restores guest RAM and native VFS inodes", {
  skip:
    skip || backend !== "firecracker" || process.env.GONDOLIN_JAILER !== "0",
  timeout: 120000,
}, async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-state-roundtrip-"),
  );
  const vms: VM[] = [];
  t.after(async () => {
    for (const vm of vms) await vm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const options = {
    sandbox: {
      vmm: "firecracker" as const,
      netEnabled: false,
      nitro: false as const,
      debug: ["protocol", "timing"] as const,
    },
    startTimeoutMs: 30000,
    rootfs: { mode: "memory" as const },
    vfs: { mounts: { "/scratch": nativeMounts.memory() } },
  };
  const vm = await VM.create(options);
  vms.push(vm);
  t.diagnostic("booting and populating the snapshot source");
  assert.equal(
    (
      await vm.exec(
        "printf ram >/tmp/ram-state; printf vfs >/data/scratch/file; ln /data/scratch/file /data/scratch/link",
      )
    ).exitCode,
    0,
  );
  const inode = (await vm.exec("stat -c %i /data/scratch/file")).stdout;
  t.diagnostic("capturing guest RAM and native VFS state");
  const snapshot = await vm.createFirecrackerSnapshot(
    path.join(dir, "snapshot"),
  );
  assert.equal(fs.statSync(snapshot.memPath).mode & 0o777, 0o600);
  t.diagnostic("checking the source resumed after capture");
  assert.equal(
    (await vm.exec("cat /tmp/ram-state /data/scratch/link")).stdout,
    "ramvfs",
  );
  assert.equal(
    (await vm.exec("printf changed >/tmp/ram-state; printf changed >/data/scratch/file")).exitCode,
    0,
  );
  await vm.close();
  t.diagnostic("restoring into a new host session");
  const restored = await VM.restoreFirecrackerSnapshot(snapshot, options);
  vms.push(restored);
  t.diagnostic("checking restored RAM, hard links and inode identity");
  assert.equal(
    (await restored.exec("cat /tmp/ram-state /data/scratch/link")).stdout,
    "ramvfs",
  );
  assert.equal(
    (await restored.exec("stat -c %i /data/scratch/file")).stdout,
    inode,
  );
});
