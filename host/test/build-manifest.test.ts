import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeAssetBuildId } from "../src/assets.ts";
import {
  FIRECRACKER_KERNEL_FILENAME,
  INITRAMFS_FILENAME,
  KERNEL_FILENAME,
  ROOTFS_FILENAME,
  writeAssetManifest,
} from "../src/build/shared.ts";
import type { BuildConfig } from "../src/build/config.ts";

function makeConfig(): BuildConfig {
  return {
    arch: "x86_64",
    distro: "alpine",
    alpine: {
      version: "3.23.0",
    },
  };
}

test("builder: writeAssetManifest includes Firecracker checksums when assets exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-manifest-"));

  try {
    fs.writeFileSync(path.join(dir, KERNEL_FILENAME), "kernel");
    fs.writeFileSync(path.join(dir, INITRAMFS_FILENAME), "initramfs");
    fs.writeFileSync(path.join(dir, ROOTFS_FILENAME), "rootfs");
    fs.writeFileSync(
      path.join(dir, FIRECRACKER_KERNEL_FILENAME),
      "firecracker-kernel",
    );

    const { manifest } = writeAssetManifest(dir, makeConfig());

    assert.equal(
      manifest.assets.firecrackerKernel,
      FIRECRACKER_KERNEL_FILENAME,
    );
    assert.ok(manifest.checksums.firecrackerKernel);
    assert.equal(
      manifest.buildId,
      computeAssetBuildId({ checksums: manifest.checksums, arch: "x86_64" }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("builder: writeAssetManifest omits Firecracker checksums when assets are absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-manifest-"));

  try {
    fs.writeFileSync(path.join(dir, KERNEL_FILENAME), "kernel");
    fs.writeFileSync(path.join(dir, INITRAMFS_FILENAME), "initramfs");
    fs.writeFileSync(path.join(dir, ROOTFS_FILENAME), "rootfs");

    const { manifest } = writeAssetManifest(dir, makeConfig());

    assert.equal(manifest.assets.firecrackerKernel, undefined);
    assert.equal(manifest.checksums.firecrackerKernel, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("builder: writeAssetManifest records disabled Firecracker initrd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-manifest-"));

  try {
    fs.writeFileSync(path.join(dir, KERNEL_FILENAME), "kernel");
    fs.writeFileSync(path.join(dir, INITRAMFS_FILENAME), "initramfs");
    fs.writeFileSync(path.join(dir, ROOTFS_FILENAME), "rootfs");
    fs.writeFileSync(
      path.join(dir, FIRECRACKER_KERNEL_FILENAME),
      "firecracker-kernel",
    );

    const { manifest } = writeAssetManifest(dir, {
      ...makeConfig(),
      firecrackerInitrdPath: null,
    });

    assert.equal(manifest.assets.firecrackerInitrd, null);
    assert.equal(manifest.checksums.firecrackerInitrd, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
