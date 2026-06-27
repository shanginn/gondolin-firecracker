import assert from "node:assert/strict";
import test from "node:test";

import { __test as vfkitTest } from "../src/sandbox/vfkit-controller.ts";

test("buildVfkitArgs builds Linux boot, block, vsock, and console devices", () => {
  const args = vfkitTest.buildVfkitArgs({
    vfkitPath: "vfkit",
    vsockPath: "/tmp/gondolin-vfkit-vsock-test.sock",
    kernelPath: "/tmp/kernel",
    initrdPath: "/tmp/initrd",
    rootDiskPath: "/tmp/rootfs.ext4",
    rootDiskFormat: "raw",
    memory: "512M",
    cpus: 2,
    append:
      "console=hvc0 root=/dev/vda ro init=/init sandboxfs.bind=/workspace,/src",
    console: "stdio",
    autoRestart: false,
  });

  assert.deepEqual(args.slice(0, 6), [
    "--cpus",
    "2",
    "--memory",
    "512",
    "--bootloader",
    'linux,kernel=/tmp/kernel,initrd=/tmp/initrd,cmdline="console=hvc0 root=/dev/vda ro init=/init sandboxfs.bind=/workspace,/src"',
  ]);
  assert.ok(args.includes("--device"));
  assert.ok(args.includes("virtio-blk,path=/tmp/rootfs.ext4"));
  assert.ok(
    args.includes(
      "virtio-vsock,port=1024,socketURL=/tmp/gondolin-vfkit-vsock-test.sock_1024",
    ),
  );
  assert.ok(args.includes("virtio-rng"));
  assert.ok(args.includes("virtio-serial,stdio"));
});

test("buildVfkitArgs rejects comma-containing paths", () => {
  assert.throws(
    () =>
      vfkitTest.buildVfkitArgs({
        vfkitPath: "vfkit",
        vsockPath: "/tmp/gondolin-vfkit.sock",
        kernelPath: "/tmp/kernel,with-comma",
        initrdPath: "/tmp/initrd",
        rootDiskPath: "/tmp/rootfs.ext4",
        rootDiskFormat: "raw",
        memory: "512M",
        cpus: 1,
        append: "root=/dev/vda",
        console: "none",
        autoRestart: false,
      }),
    /kernel path cannot contain commas/,
  );
});
