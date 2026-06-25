# Current Limitations

## Linux/KVM Only

The runtime requires Linux with `/dev/kvm`. macOS and Windows hosts are not
supported by the Firecracker backend.

## Mediated Guest Egress Requires Host Network Capabilities

Guest egress is disabled by default. Enabling it creates a TAP device and
requires Python 3, iproute2, `/dev/net/tun`, `CAP_NET_ADMIN`, and `CAP_NET_RAW`.
The guest still cannot use generic host NAT; DHCP, DNS, TCP, HTTP(S), mapped
TCP, and outbound SSH are mediated by the host policy stack.

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
