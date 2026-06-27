# Current Limitations

## Firecracker Is Linux/KVM Only

The Firecracker backend requires Linux with `/dev/kvm`. Windows hosts are not
supported. macOS hosts can use the experimental `vfkit` backend for local
Apple Silicon development.

## vfkit Backend Is Experimental

The vfkit backend runs on macOS and uses `vfkitKernel`/initramfs/rootfs assets
plus guest-to-host vsock sockets. It does not support mediated guest egress,
Firecracker VM-state snapshots, or the current x86_64 tiny Firecracker kernel
profile. On Apple Silicon, vfkit's Linux bootloader requires an uncompressed
arm64 kernel; images built only around Firecracker PVH/KVM kernels are not
expected to boot. Use `images/alpine-vfkit.json` for the working aarch64 local
development profile.

## Mediated Guest Egress Requires Host Network Capabilities

Guest egress is disabled by default. Enabling it on Firecracker creates a TAP
device and requires Python 3, iproute2, `/dev/net/tun`, `CAP_NET_ADMIN`, and
`CAP_NET_RAW`. The guest still cannot use generic host NAT; DHCP, DNS, TCP,
HTTP(S), mapped TCP, and outbound SSH are mediated by the host policy stack.
vfkit mediated guest egress is not implemented yet.

## No Full VM Save/Restore

Checkpoints are disk-only. They do not capture RAM or process state.

## Root Disk Only

Disk checkpoints capture the root disk. VFS mounts and tmpfs-backed paths are
not included.

## Alpine Image Builder

The included image builder targets Alpine Linux. Other distributions require a
custom image pipeline that emits compatible Firecracker kernel/initrd/rootfs
assets.

## Writable Rootfs Copies Cost Disk And Time

The default rootfs mode is read-only. `rootfs.mode="cow"`,
`rootfs.mode="memory"`, and `rootfs.size` use temporary raw disk copies, so size
scratch storage for one copy per concurrent VM.
