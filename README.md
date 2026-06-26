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

For lower cold-start and memory floors, the repo also includes:

- `scripts/build-fast-agent-init.sh`: builds a stripped static `/init` for the
  agent profile
- `images/alpine-fast-firecracker.json`: tiny kernel, static init, ext4 rootfs,
  no Firecracker initrd
- `images/alpine-initramfs-firecracker.json`: tiny kernel plus static init
  running directly from initramfs
- `VM#getStartupTimings()`, `VM#createFirecrackerSnapshot()`, and
  `VM.restoreFirecrackerSnapshot()` for phase timing and same-host snapshot
  restore experiments

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

Measured on a single-vCPU KVM VPS on June 26, 2026 with warm guest assets:
Debian Linux `6.12.85+deb13-amd64`, `1` vCPU (`AMD EPYC 7543` under KVM),
`1.9 GiB` RAM, Firecracker `v1.16.0`, QEMU `10.0.8`, Node.js `v26.4.0`,
Zig `0.16.0`.

Each value is the median of `5` runs with `1` vCPU, no serial console, guest
networking disabled, and `50` warm `/bin/true` execs per run. The default
Firecracker and QEMU columns use the checked-in `images/alpine-base.json`
x86_64 image. The tiny Firecracker column uses
`images/alpine-tiny-firecracker.json`. The QEMU column is the original
Gondolin/QEMU runtime from `@earendil-works/gondolin@0.12.0`, using the same
default x86_64 image.

| Metric                    | Firecracker default (`84M`) | Firecracker tiny (`29M`) | QEMU original (`256M`) |
| ------------------------- | --------------------------: | -----------------------: | ---------------------: |
| VM object creation        |                    `1.7 ms` |                 `1.7 ms` |               `366 ms` |
| VM start to ready         |                    `1.72 s` |                 `1.01 s` |               `4.38 s` |
| First `/bin/true` exec    |                    `6.1 ms` |                `13.9 ms` |               `9.0 ms` |
| Warm `/bin/true` exec p50 |                   `12.5 ms` |                `15.9 ms` |              `23.6 ms` |
| Warm `/bin/true` exec p95 |                   `18.3 ms` |                `16.9 ms` |              `31.7 ms` |
| VMM RSS after warm execs  |                  `84.7 MiB` |               `28.3 MiB` |            `171.5 MiB` |
| VMM VSZ after warm execs  |                  `92.1 MiB` |               `37.1 MiB` |            `649.9 MiB` |
| VM close                  |                   `41.2 ms` |                `37.4 ms` |              `23.7 ms` |

Memory floor smoke tests used `console: "none"`, `netEnabled: true`, bash, and
an outbound HTTP fetch from the guest. The optimized image passed `84M` for
`20/20` boots. `80M` was intentionally not chosen as the default because it
passed only `9/10` boots; `76M` failed `5/5`. The initramfs prune reduced the
default compressed initramfs from `5.9M` to `2.3M` (`11M` to `3.6M`
uncompressed).

Sub-`50M` is not a supported target for the default Alpine image. On x86_64,
Firecracker boots an uncompressed ELF kernel; the current Alpine-derived
Firecracker kernel asset is `38M` before the initramfs and guest userspace are
loaded. A June 25, 2026 sweep with VFS disabled (`vfs: null`) still failed at
`48M`, `50M`, `52M`, `56M`, `60M`, `64M`, and `72M`, then passed at `80M`.
Booting the compressed Alpine `vmlinuz-virt` directly failed, and stripping BTF
metadata from the ELF produced a smaller kernel that hung at `80M`.

For the agent-sandbox floor, build the tiny Firecracker kernel and disable the
Firecracker initrd in the image manifest:

```bash
scripts/build-tiny-firecracker-kernel.sh
scripts/build-fast-agent-init.sh
gondolin build --config images/alpine-tiny-firecracker.json --output ./guest/image/tiny
gondolin build --config images/alpine-fast-firecracker.json --output ./guest/image/fast
gondolin build --config images/alpine-initramfs-firecracker.json --output ./guest/image/initramfs
```

The tiny profile uses a Linux `6.1.142` `tinyconfig`-derived PVH/KVM guest
kernel (`15M` uncompressed ELF) with virtio block, virtio net, vsock, ext4,
FUSE, ptys, IPv4, and bash-capable process support built in. It keeps
`bash` and `ca-certificates` in the rootfs and sets
`manifest.assets.firecrackerInitrd` to `null`. The fast profile swaps the shell
init script for the static init. The initramfs profile copies `sandboxd`,
`sandboxfs`, bash, and certificates into initramfs and skips `switch_root`.

A June 26, 2026 smoke sweep on the same KVM host used `netEnabled: true`, a
VFS-backed file write/read, `/bin/bash`, and an outbound HTTP fetch. `29M`
passed `20/20` boots with `MemTotal` around `18.3 MiB`; `28M` timed out, and
`26M` and lower failed kernel loading. Use `30M` when you want a small guard
band; use `84M` for the default published image.

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
