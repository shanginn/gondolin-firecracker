import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";

function hostManifestArch(): "aarch64" | "x86_64" {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

function makeAssets(includeFirecracker = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-fc-assets-"));
  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "kernel");
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "initramfs");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "rootfs");
  if (includeFirecracker) {
    fs.writeFileSync(path.join(dir, "firecracker-kernel"), "fc-kernel");
  }

  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
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
        ...(includeFirecracker
          ? { firecrackerKernel: "firecracker-kernel" }
          : {}),
      },
      checksums: {
        kernel: "",
        initramfs: "",
        rootfs: "",
        ...(includeFirecracker ? { firecrackerKernel: "" } : {}),
      },
    }),
  );

  return dir;
}

test("resolveSandboxServerOptions resolves Firecracker manifest assets", () => {
  const dir = makeAssets();
  try {
    const resolved = resolveSandboxServerOptions(
      { imagePath: dir },
      undefined,
      { platform: "linux" },
    );

    assert.equal(resolved.vmm, "firecracker");
    assert.equal(resolved.kernelPath, path.join(dir, "firecracker-kernel"));
    assert.equal(resolved.rootDiskFormat, "raw");
    assert.equal(resolved.netEnabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects non-Linux hosts", () => {
  const dir = makeAssets();
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions(
          { imagePath: dir },
          undefined,
          { platform: "darwin" },
        ),
      /requires Linux\/KVM/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions requires Firecracker boot assets", () => {
  const dir = makeAssets(false);
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions(
          { imagePath: dir },
          undefined,
          { platform: "linux" },
        ),
      /does not provide Firecracker boot assets/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects unsupported and mediated network options", () => {
  const dir = makeAssets();
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions(
          { imagePath: dir, machineType: "virt" } as any,
          undefined,
          { platform: "linux" },
        ),
      /Unsupported Firecracker option: sandbox\.machineType/,
    );

    assert.throws(
      () =>
        resolveSandboxServerOptions(
          { imagePath: dir, netEnabled: true },
          undefined,
          { platform: "linux" },
        ),
      /mediated networking is not implemented/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
