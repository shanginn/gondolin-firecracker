# Gondolin

Firecracker-backed Linux micro-VM runtime for Node.js.

## Requirements

- Linux with `/dev/kvm`
- Firecracker on `PATH` or `GONDOLIN_FIRECRACKER=/path/to/firecracker`
- Node.js `>=23.6`

## Install

```bash
npm install @earendil-works/gondolin
```

## CLI

```bash
npx @earendil-works/gondolin bash
npx @earendil-works/gondolin list
npx @earendil-works/gondolin attach <session-id>
npx @earendil-works/gondolin snapshot <session-id>
npx @earendil-works/gondolin bash --resume <snapshot-id-or-raw-path>
```

## SDK

```ts
import { VM, MemoryProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: { "/workspace": new MemoryProvider() },
  },
});

const result = await vm.exec("pwd && id");
console.log(result.stdout);

await vm.close();
```

## Runtime Defaults

- Firecracker only
- `1` vCPU
- `84M` guest memory
- read-only base rootfs
- raw root disks only
- vsock control, VFS, SSH helper, and ingress channels
- no guest egress network

Use `rootfs.mode="cow"` when the workload must write to the root disk. Use VFS
mounts for workspaces and persistent data.

## Kubernetes

See [docs/kubernetes.md](../docs/kubernetes.md). Pods need Linux/KVM device
access and a short writable `GONDOLIN_RUNTIME_DIR` for Firecracker sockets.
