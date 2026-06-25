# Gondolin Firecracker Sandbox

**Linux micro-VMs for agent workloads, backed only by Firecracker.**

Gondolin runs untrusted code inside a Firecracker VM and exposes a small host
control plane for command execution, VFS mounts, optional host-to-guest SSH,
ingress, and disk checkpoints. The runtime is Linux/KVM only.

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
- Python 3 and `ip` from iproute2 when mediated guest egress is enabled
- `/dev/net/tun` plus `CAP_NET_ADMIN`/`CAP_NET_RAW` when mediated guest egress is enabled
- Node.js `>=23.6`
- Guest assets with `manifest.assets.firecrackerKernel`

Defaults are tuned for low memory and startup cost: `1` vCPU, `84M`, no serial
console, no guest network device unless `netEnabled` is set, and read-only base
rootfs. Use VFS mounts for workspace data. Use `rootfs.mode="cow"` only when the
workload must write into the root disk.

The default Alpine image keeps the guest base intentionally small:
`linux-virt`, `bash`, `ca-certificates`, and `curl`. Add packages such as
`openssh`, `python3`, `nodejs`, `npm`, `uv`, or `e2fsprogs` through a custom
image when a workload actually needs them.

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

Guest egress is disabled by default. When enabled, Firecracker attaches to a
short-lived TAP device and Gondolin mediates DHCP, DNS, TCP, HTTP(S), mapped TCP,
and outbound SSH in the host process. Gondolin does not install host NAT rules;
guest packets only leave through the configured policy hooks. Host-to-guest
ingress and host-to-guest SSH use vsock-backed forwarders.

## Benchmark Snapshot

Measured on a single-vCPU KVM VPS on June 25, 2026 with warm guest assets:
Debian Linux `6.12.85+deb13-amd64`, `1` vCPU (`AMD EPYC 7543` under KVM),
`1.9 GiB` RAM, Firecracker `v1.16.0`, QEMU `10.0.8`, Node.js `v26.4.0`,
Zig `0.16.0`.

```bash
node host/examples/backend-benchmark.ts --iterations 50
```

Each Firecracker value is the median of `5` runs with `1` vCPU, `84M`, no
serial console, guest networking disabled, and the optimized default Alpine
image. The QEMU numbers are the original Gondolin/QEMU baseline measured on the
same host with `1` vCPU and `256M` using `@earendil-works/gondolin@0.12.0`.

| Metric | Firecracker | QEMU |
| --- | ---: | ---: |
| VM object creation | `8.4 ms` | `26.9 ms` |
| VM start to ready | `610 ms` | `4.00 s` |
| First `/bin/true` exec | `14.2 ms` | `27.8 ms` |
| Warm `/bin/true` exec p50 | `13.2 ms` | `23.8 ms` |
| Warm `/bin/true` exec p95 | `15.5 ms` | `35.0 ms` |
| VMM RSS after warm execs | `90.8 MiB` | `188 MiB` |
| VMM VSZ after warm execs | `92.1 MiB` | `653 MiB` |
| VM close | `37.6 ms` | `29.0 ms` |

Memory floor smoke tests used `console: "none"`, `netEnabled: true`, bash, and
an outbound HTTP fetch from the guest. The optimized image passed `84M` for
`20/20` boots. `80M` was intentionally not chosen as the default because it
passed only `9/10` boots; `76M` failed `5/5`. The initramfs prune reduced the
default compressed initramfs from `5.9M` to `2.3M` (`11M` to `3.6M`
uncompressed).

This benchmark isolates VM lifecycle and tiny command latency. Network, VFS, and
agent workload benchmarks should be measured separately.

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
