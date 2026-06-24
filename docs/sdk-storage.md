# Filesystem, Guest Assets, and Snapshots

## VFS Mounts

Use VFS mounts for workspace data and host-provided files.

```ts
import { VM, RealFSProvider, ReadonlyProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      "/workspace": new ReadonlyProvider(new RealFSProvider("/host/project")),
    },
  },
});
```

## Rootfs Modes

- `readonly` is the default. It attaches the base raw rootfs read-only.
- `cow` creates a temporary writable raw rootfs copy.
- `memory` currently also creates a temporary writable raw rootfs copy.

Use `readonly` for fastest startup and lowest scratch usage. Use writable modes
only when the workload must write outside tmpfs and VFS mounts.

## Runtime Rootfs Size

`rootfs.size` grows the effective writable raw root disk before boot:

```ts
const vm = await VM.create({
  rootfs: { mode: "cow", size: "2G" },
});
```

The base image is never resized in place.

## Guest Assets

Guest assets are resolved from an image selector, an asset directory, or
`GONDOLIN_GUEST_DIR`. Firecracker images must include:

- `vmlinuz-virt`
- `initramfs.cpio.lz4`
- `rootfs.ext4`
- `manifest.json`
- `manifest.assets.firecrackerKernel`

## Checkpoints

Checkpoints are raw root disk files with a metadata trailer.

```ts
import path from "node:path";

const vm = await VM.create({ rootfs: { mode: "cow" } });
await vm.exec("echo marker > /etc/checkpoint-marker");

const checkpoint = await vm.checkpoint(path.resolve("./dev-base.raw"));
const resumed = await checkpoint.resume();
```

Checkpoints require guest assets with `manifest.buildId`. Resume finds matching
assets by build id or uses `sandbox.imagePath` when provided.

See [Snapshots](./snapshots.md).
