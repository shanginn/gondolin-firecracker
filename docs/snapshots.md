# Snapshots

Gondolin supports disk-only checkpoints of the VM root disk and Firecracker
VM-state snapshots for idle same-host restore.

A checkpoint is a single raw disk file with a small JSON trailer appended to the
end. Resume creates a temporary raw copy, so the same checkpoint can be resumed
multiple times.

## CLI

```bash
gondolin snapshot <session-id>
gondolin bash --resume <snapshot-id>
gondolin bash --resume /path/to/snapshot.raw
```

## SDK

```ts
import path from "node:path";

import { VM, VmCheckpoint } from "@earendil-works/gondolin";

const vm = await VM.create({ rootfs: { mode: "cow" } });
await vm.exec("echo hello > /etc/snapshot-marker");

const checkpointPath = path.resolve("./my-snapshot.raw");
const checkpoint = await vm.checkpoint(checkpointPath);

const resumed = await checkpoint.resume();
await resumed.exec("cat /etc/snapshot-marker");

await resumed.close();
checkpoint.delete();

const loaded = VmCheckpoint.load(checkpointPath);
await loaded.resume();
```

## Notes

- Checkpoints are disk-only; RAM and process state are not captured.
- Creating a checkpoint stops and consumes the VM.
- Only the root disk is captured.
- Tmpfs-backed paths such as `/tmp`, `/root`, `/var/tmp`, `/var/cache`, and
  `/var/log` are not captured.
- Guest assets must have a `manifest.json` with a deterministic `buildId`.
- Resume finds matching assets by build id or uses `sandbox.imagePath`.
- Tools that rewrite the raw file may drop the metadata trailer.

## Firecracker VM-State Snapshots

Use VM-state snapshots when you want a fast restore on the same host class:

```ts
const snapshot = await vm.createFirecrackerSnapshot("./vm-state");
await vm.close();

const restored = await VM.restoreFirecrackerSnapshot(snapshot, {
  sandbox: { imagePath: "./guest/image/fast" },
});
await restored.exec("echo restored");
```

`createFirecrackerSnapshot()` waits for active exec, file, VFS, and network work
to drain, rejects new guest work during capture, and stores the boot config plus
VFS RPC inode map in the returned snapshot object. Restore expects compatible
image, kernel, root disk paths, and host-provided VFS state. Use disk
checkpoints, VFS providers, or external storage for durable persistence across
hosts or image upgrades.
