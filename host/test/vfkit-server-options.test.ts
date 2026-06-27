import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";

function hostManifestArch(): "aarch64" | "x86_64" {
  return process.arch === "arm64" ? "aarch64" : "x86_64";
}

function makeAssets(includeVfkit = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-vfkit-assets-"));
  fs.writeFileSync(path.join(dir, "vmlinuz-virt"), "kernel");
  fs.writeFileSync(path.join(dir, "initramfs.cpio.lz4"), "initramfs");
  fs.writeFileSync(path.join(dir, "rootfs.ext4"), "rootfs");
  if (includeVfkit) {
    fs.writeFileSync(path.join(dir, "vfkit-kernel"), "vfkit-kernel");
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
        ...(includeVfkit ? { vfkitKernel: "vfkit-kernel" } : {}),
      },
      checksums: {
        kernel: "",
        initramfs: "",
        rootfs: "",
        ...(includeVfkit ? { vfkitKernel: "" } : {}),
      },
    }),
  );

  return dir;
}

test("resolveSandboxServerOptions resolves vfkit assets without Firecracker boot assets", () => {
  const dir = makeAssets();
  try {
    const resolved = resolveSandboxServerOptions(
      { vmm: "vfkit", imagePath: dir },
      undefined,
      { platform: "darwin" },
    );

    assert.equal(resolved.vmm, "vfkit");
    assert.equal(resolved.vfkitPath, "vfkit");
    assert.equal(resolved.kernelPath, path.join(dir, "vfkit-kernel"));
    assert.equal(resolved.initrdPath, path.join(dir, "initramfs.cpio.lz4"));
    assert.equal(resolved.netEnabled, false);
    assert.match(resolved.virtioSocketPath, /gondolin-vfkit-vsock-.+_1024/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions requires vfkit boot assets for manifest images", () => {
  const dir = makeAssets(false);
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions(
          { vmm: "vfkit", imagePath: dir },
          undefined,
          { platform: "darwin" },
        ),
      /does not provide vfkit boot assets/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects vfkit outside macOS", () => {
  const dir = makeAssets();
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions(
          { vmm: "vfkit", imagePath: dir },
          undefined,
          { platform: "linux" },
        ),
      /vfkit backend requires macOS/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects vfkit mediated egress", () => {
  const dir = makeAssets();
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions(
          { vmm: "vfkit", imagePath: dir, netEnabled: true },
          undefined,
          { platform: "darwin" },
        ),
      /does not support mediated guest egress/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects backend-specific option mixups", () => {
  const dir = makeAssets();
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions(
          {
            vmm: "vfkit",
            imagePath: dir,
            firecrackerPath: "/bin/firecracker",
          },
          undefined,
          { platform: "darwin" },
        ),
      /Unsupported vfkit option: sandbox\.firecrackerPath/,
    );

    assert.throws(
      () =>
        resolveSandboxServerOptions(
          {
            vmm: "firecracker",
            imagePath: dir,
            vfkitPath: "/bin/vfkit",
          },
          undefined,
          { platform: "linux" },
        ),
      /Unsupported Firecracker option: sandbox\.vfkitPath/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
