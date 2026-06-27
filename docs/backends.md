# VM Backends

Gondolin defaults to the Firecracker backend on Linux/KVM. The experimental
vfkit backend can run local development VMs on macOS.

Select a backend with `sandbox.vmm` in the SDK or `--vmm` in the CLI:

```bash
gondolin bash --vmm firecracker
gondolin bash --vmm vfkit
```

## Firecracker

### Requirements

- Linux host with `/dev/kvm`
- Firecracker binary in `PATH` or configured with `GONDOLIN_FIRECRACKER`
- Guest image architecture matching the host architecture
- Image manifest with `assets.firecrackerKernel`

### Defaults

- `1` vCPU
- `84M` guest memory
- raw root disks only
- read-only base rootfs
- no serial console unless requested
- no guest network device
- vsock ports:
  - `1024` exec/control
  - `1025` VFS
  - `1026` host-to-guest SSH
  - `1027` ingress

The default image is not designed for sub-`50M` guest memory. On x86_64,
Firecracker needs an uncompressed ELF kernel, and the default Alpine-derived
kernel asset is `38M` before initramfs and userspace memory. For the smallest
agent sandbox profile, build `scripts/build-tiny-firecracker-kernel.sh` and use
`images/alpine-tiny-firecracker.json`; that no-initrd profile passed VFS,
`/bin/bash`, and mediated HTTP smoke tests at `29M` on June 26, 2026.
`images/alpine-initramfs-firecracker.json` trades memory for startup latency; it
passed the same smoke test at `50M` and failed at `49M`.

For startup work, call `vm.getStartupTimings()` after `vm.start()` to inspect
host, Firecracker API, guest boot, VFS, and session IPC phases. Same-host
Firecracker snapshots are exposed through `vm.createFirecrackerSnapshot(dir)`
and `VM.restoreFirecrackerSnapshot(snapshot, options)`. Snapshot creation waits
for active guest work to drain and rejects new exec, file, TCP, SSH, ingress, and
VFS activity during capture. Restored VMs are expected to run on the same host
class with compatible image, kernel, and root disk paths. VFS providers remain
host-owned state, while the snapshot metadata preserves the guest-facing VFS
inode map so restored FUSE mounts keep answering path operations.

## Storage

The base rootfs is attached read-only by default. `rootfs.mode="cow"` and
`rootfs.mode="memory"` create a temporary raw rootfs copy and delete it on close.
`rootfs.size` grows the effective writable raw disk before boot.

### Network

Guest egress is disabled by default. `netEnabled: true`, `httpHooks`, DNS
overrides, mapped TCP, or outbound SSH proxying enable a short-lived Firecracker
TAP device that is mediated by the host policy stack. Gondolin does not install
generic host NAT rules.

Host-to-guest ingress and optional host-to-guest SSH are supported over
vsock-backed forwarders. SSH requires a guest image with OpenSSH installed.

### Production Notes

Use short socket paths with `GONDOLIN_RUNTIME_DIR=/run/gondolin`, pin workloads
to KVM-capable nodes, and run Firecracker under the upstream jailer or equivalent
cgroup/namespace/seccomp confinement when operating multi-tenant hosts.

## vfkit

### Requirements

- macOS host with `vfkit` in `PATH` or configured with `GONDOLIN_VFKIT`
- Guest image architecture matching the host architecture
- Image manifest with `assets.vfkitKernel`, `assets.initramfs`, and
  `assets.rootfs`

### Defaults

- `1` vCPU
- `256M` guest memory
- raw root disks only
- guest-to-host virtio-vsock ports:
  - `1024` exec/control
  - `1025` VFS
  - `1026` host-to-guest SSH
  - `1027` ingress

The vfkit backend boots with vfkit's Linux bootloader, a `virtio-blk` root disk,
`virtio-rng`, and four guest-to-host `virtio-vsock` sockets. The guest still
uses `gondolin.transport=vsock`, so `sandboxd`, `sandboxfs`, `sandboxssh`, and
`sandboxingress` reuse the existing protocol.

Build a local Apple Silicon image with:

```bash
gondolin build --config images/alpine-vfkit.json --output ./guest/image/vfkit --tag alpine-vfkit:local
gondolin exec --vmm vfkit --image alpine-vfkit:local -- uname -m
```

The current x86_64 tiny Firecracker profile does not run locally on Apple
Silicon. It is an x86_64 PVH/KVM kernel profile, while vfkit on M-series Macs
needs an arm64 guest image and, for the Linux bootloader, an uncompressed arm64
kernel. `images/alpine-vfkit.json` provides a working Alpine aarch64 profile;
sub-`50M` vfkit tiny-image support is still a separate image-build task.

### Storage

vfkit's documented `virtio-blk` option does not expose a read-only device flag.
When the VM API would normally attach the base rootfs read-only, Gondolin uses a
temporary raw copy for vfkit so the published image file is not modified by a
guest remount.

### Network

Mediated guest egress is not implemented for vfkit. Do not pass
`sandbox.netEnabled`, HTTP hooks, DNS overrides, mapped TCP egress, or outbound
SSH proxy settings with `vmm: "vfkit"`. Host-to-guest ingress and host-to-guest
SSH continue to use the vsock-backed helper channels.

### Snapshots

Firecracker VM-state snapshots are not supported by vfkit. Disk checkpoints can
record that they were created with vfkit and resume with `sandbox.vmm = "vfkit"`
when the same guest image assets are available.
