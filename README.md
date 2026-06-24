# Gondolin Firecracker Sandbox

**Linux micro-VMs for agent workloads, backed only by Firecracker.**

Gondolin runs untrusted code inside a Firecracker VM and exposes a small host
control plane for command execution, VFS mounts, host-to-guest SSH, ingress, and
disk checkpoints. The runtime is Linux/KVM only.

## Quick Start

```bash
npx @earendil-works/gondolin bash
```

Useful commands:

```bash
npx @earendil-works/gondolin list
npx @earendil-works/gondolin attach <session-id>
npx @earendil-works/gondolin snapshot <session-id>
npx @earendil-works/gondolin bash --resume <snapshot-id-or-raw-path>
```

## Requirements

- Linux host with `/dev/kvm`
- Firecracker binary on `PATH` or `GONDOLIN_FIRECRACKER=/path/to/firecracker`
- Node.js `>=23.6`
- Guest assets with `manifest.assets.firecrackerKernel`

Defaults are tuned for low memory and startup cost: `1` vCPU, `256M`, no serial
console, no guest network device, and read-only base rootfs. Use VFS mounts for
workspace data. Use `rootfs.mode="cow"` only when the workload must write into
the root disk.

## SDK Example

```ts
import { VM, MemoryProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: { "/workspace": new MemoryProvider() },
  },
});

const result = await vm.exec("echo hello from $(uname -m)");
console.log(result.stdout);

await vm.close();
```

## Network Model

Guest egress is disabled in the Firecracker runtime. `httpHooks`, DNS overrides,
mapped TCP, outbound SSH proxying, and `netEnabled: true` are rejected instead of
silently bypassing policy. Host-to-guest ingress and host-to-guest SSH still use
vsock-backed forwarders.

## Development

```bash
make build
make check
make test
```

Repo layout:

- `guest/` - Zig guest daemons and Alpine image build
- `host/` - TypeScript host controller, SDK, and CLI
- `docs/` - operating notes and API docs
- `examples/` - usage examples

## Documentation

- [CLI](docs/cli.md)
- [SDK](docs/sdk.md)
- [Architecture](docs/architecture.md)
- [Kubernetes](docs/kubernetes.md)
- [Security](docs/security.md)
- [Limitations](docs/limitations.md)
