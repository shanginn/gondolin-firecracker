# Snapshots

Gondolin supports disk-only checkpoints of the VM root disk.

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
