import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BuildConfig } from "../src/build/config.ts";
import { __test } from "../src/build/native.ts";
import {
  FIRECRACKER_INITRD_FILENAME,
  FIRECRACKER_KERNEL_FILENAME,
  INITRAMFS_FILENAME,
  KERNEL_FILENAME,
  ROOTFS_FILENAME,
  VFKIT_KERNEL_FILENAME,
} from "../src/build/shared.ts";

function config(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    arch: "x86_64",
    distro: "alpine",
    alpine: { version: "3.23.0" },
    ...overrides,
  };
}

function writeRequiredAssets(workDir: string): void {
  fs.writeFileSync(path.join(workDir, KERNEL_FILENAME), "kernel");
  fs.writeFileSync(path.join(workDir, INITRAMFS_FILENAME), "initramfs");
  fs.writeFileSync(path.join(workDir, ROOTFS_FILENAME), "rootfs");
  fs.writeFileSync(
    path.join(workDir, FIRECRACKER_KERNEL_FILENAME),
    "firecracker kernel",
  );
}

test("Firecracker-only asset shortcut remains x86_64-specific", () => {
  const base = {
    firecrackerKernelPath: "./vmlinux",
    firecrackerInitrdPath: null,
  } satisfies Partial<BuildConfig>;
  assert.equal(__test.usesFirecrackerOnlyAssets(config(base)), true);
  assert.equal(
    __test.usesFirecrackerOnlyAssets(config({ ...base, arch: "aarch64" })),
    false,
  );
});

test("native asset copy publishes and removes custom Firecracker initrds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-native-assets-"));
  const workDir = path.join(dir, "work");
  const outputDir = path.join(dir, "output");
  fs.mkdirSync(workDir);
  writeRequiredAssets(workDir);
  fs.writeFileSync(
    path.join(workDir, FIRECRACKER_INITRD_FILENAME),
    "custom initrd",
  );

  try {
    __test.copyNativeBuildAssets(
      config({ firecrackerInitrdPath: "./custom-initrd" }),
      workDir,
      outputDir,
    );
    assert.equal(
      fs.readFileSync(
        path.join(outputDir, FIRECRACKER_INITRD_FILENAME),
        "utf8",
      ),
      "custom initrd",
    );

    __test.copyNativeBuildAssets(config(), workDir, outputDir);
    assert.equal(
      fs.existsSync(path.join(outputDir, FIRECRACKER_INITRD_FILENAME)),
      false,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("native asset copy falls back when hard links are unavailable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-native-link-"));
  const src = path.join(dir, "src");
  const dst = path.join(dir, "dst");
  fs.writeFileSync(src, "kernel");
  const originalLinkSync = fs.linkSync;
  fs.linkSync = () => {
    throw new Error("hard links unavailable");
  };
  try {
    __test.linkOrCopyFile(src, dst);
    assert.equal(fs.readFileSync(dst, "utf8"), "kernel");
  } finally {
    fs.linkSync = originalLinkSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("native asset copy retains optional vfkit kernel", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-native-vfkit-"));
  const workDir = path.join(dir, "work");
  const outputDir = path.join(dir, "output");
  fs.mkdirSync(workDir);
  writeRequiredAssets(workDir);
  fs.writeFileSync(path.join(workDir, VFKIT_KERNEL_FILENAME), "vfkit kernel");
  try {
    __test.copyNativeBuildAssets(
      config({ vfkitKernelPath: "./vfkit-kernel" }),
      workDir,
      outputDir,
    );
    assert.equal(
      fs.readFileSync(path.join(outputDir, VFKIT_KERNEL_FILENAME), "utf8"),
      "vfkit kernel",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
