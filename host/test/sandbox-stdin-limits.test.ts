import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";

function hostManifestArch(): "aarch64" | "x86_64" {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

function makeTempAssetsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-stdin-"));

  // Required asset files (can be empty for this test).
  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "");
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "");
  fs.writeFileSync(path.join(dir, "firecracker-kernel"), "");

  // A minimal manifest so arch detection passes.
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        config: {
          arch: hostManifestArch(),
          distro: "alpine",
          alpine: { version: "3.23.0" },
        },
        buildTime: new Date().toISOString(),
        assets: {
          kernel: "vmlinuz-virt",
          initramfs: "initramfs.cpio.lz4",
          rootfs: "rootfs.ext4",
          firecrackerKernel: "firecracker-kernel",
        },
        checksums: {
          kernel: "",
          initramfs: "",
          rootfs: "",
          firecrackerKernel: "",
        },
      },
      null,
      2,
    ),
  );

  return dir;
}

test("resolveSandboxServerOptions ensures queued stdin caps are >= maxStdinBytes", () => {
  const dir = makeTempAssetsDir();
  try {
    const resolved = resolveSandboxServerOptions(
      {
        imagePath: dir,
        maxStdinBytes: 16 * 1024 * 1024,
      },
      undefined,
      { platform: "linux" },
    );

    assert.ok(resolved.maxQueuedStdinBytes >= resolved.maxStdinBytes);
    assert.ok(
      resolved.maxTotalQueuedStdinBytes >= resolved.maxQueuedStdinBytes,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
