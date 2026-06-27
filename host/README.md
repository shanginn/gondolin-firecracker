# Gondolin

Linux micro-VM runtime for Node.js.

## Requirements

- Firecracker backend: Linux with `/dev/kvm`
- Firecracker backend: Firecracker on `PATH` or `GONDOLIN_FIRECRACKER=/path/to/firecracker`
- vfkit backend: macOS with `vfkit` on `PATH` or `GONDOLIN_VFKIT=/path/to/vfkit`
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

- Firecracker by default; experimental vfkit backend on macOS
- `1` vCPU on Firecracker, `1` vCPU on vfkit
- `84M` guest memory on Firecracker, `256M` on vfkit
- read-only base rootfs
- raw root disks only
- vsock control, VFS, SSH helper, and ingress channels
- no guest egress network

Use `rootfs.mode="cow"` when the workload must write to the root disk. Use VFS
mounts for workspaces and persistent data. Select local macOS execution with
`sandbox.vmm = "vfkit"` or `gondolin bash --vmm vfkit`.

For Apple Silicon local development, use a published vfkit image with a package
build that includes the vfkit backend. The current npm package
`@earendil-works/gondolin@0.12.0` does not include it yet.

```bash
brew install vfkit
GONDOLIN_IMAGE_REGISTRY_URL=https://raw.githubusercontent.com/shanginn/gondolin-firecracker/master/builtin-image-registry.json \
  node host/bin/gondolin.ts exec --vmm vfkit --image alpine-vfkit:latest -- uname -m
```

Or build the vfkit image profile locally with Docker Desktop:

```bash
gondolin build --config images/alpine-vfkit.json --output ./guest/image/vfkit --tag alpine-vfkit:local
gondolin exec --vmm vfkit --image alpine-vfkit:local -- uname -m
```

## Kubernetes

See [docs/kubernetes.md](../docs/kubernetes.md). Pods need Linux/KVM device
access and a short writable `GONDOLIN_RUNTIME_DIR` for Firecracker sockets.
