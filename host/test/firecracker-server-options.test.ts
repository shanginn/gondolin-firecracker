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

function setFirecrackerInitrd(dir: string, value: string | null) {
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.assets.firecrackerInitrd = value;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
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

test("resolveSandboxServerOptions supports Firecracker kernel without initrd", () => {
  const dir = makeAssets();
  try {
    setFirecrackerInitrd(dir, null);

    const resolved = resolveSandboxServerOptions(
      { imagePath: dir },
      undefined,
      { platform: "linux" },
    );

    assert.equal(resolved.kernelPath, path.join(dir, "firecracker-kernel"));
    assert.equal(
      resolved.initrdPath,
      path.join(dir, ".gondolin-no-firecracker-initrd"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects non-Linux hosts", () => {
  const dir = makeAssets();
  try {
    assert.throws(
      () =>
        resolveSandboxServerOptions({ imagePath: dir }, undefined, {
          platform: "darwin",
        }),
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
        resolveSandboxServerOptions({ imagePath: dir }, undefined, {
          platform: "linux",
        }),
      /does not provide Firecracker boot assets/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions rejects unsupported options and accepts mediated networking", () => {
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

    const resolved = resolveSandboxServerOptions(
      {
        imagePath: dir,
        netEnabled: true,
        netTapName: "gtaptest0",
        allowWebSockets: false,
      },
      undefined,
      { platform: "linux" },
    );

    assert.equal(resolved.netEnabled, true);
    assert.equal(resolved.netTapName, "gtaptest0");
    assert.equal(resolved.allowWebSockets, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxServerOptions normalizes Firecracker snapshot paths", () => {
  const dir = makeAssets();
  try {
    const resolved = resolveSandboxServerOptions(
      {
        imagePath: dir,
        firecrackerSnapshot: {
          snapshotPath: "./vm.fc",
          memPath: "./vm.mem",
          vfsState: {
            nextIno: 4,
            pathToIno: [["/", 1], ["/workspace/file.txt", 3]],
          },
          bootConfig: {
            fuseMount: "/data",
            fuseBinds: ["/workspace"],
          },
        },
      },
      undefined,
      { platform: "linux" },
    );

    assert.equal(
      resolved.firecrackerSnapshot?.snapshotPath,
      path.resolve("vm.fc"),
    );
    assert.equal(resolved.firecrackerSnapshot?.memPath, path.resolve("vm.mem"));
    assert.deepEqual(resolved.firecrackerSnapshot?.vfsState, {
      nextIno: 4,
      pathToIno: [["/", 1], ["/workspace/file.txt", 3]],
    });
    assert.deepEqual(resolved.firecrackerSnapshot?.bootConfig, {
      fuseMount: "/data",
      fuseBinds: ["/workspace"],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
