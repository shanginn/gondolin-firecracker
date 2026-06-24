# Current Limitations

## Linux/KVM Only

The runtime requires Linux with `/dev/kvm`. macOS and Windows hosts are not
supported by the Firecracker backend.

## No Guest Egress Network

Guest egress networking is disabled. HTTP hooks, DNS overrides, mapped TCP, and
outbound SSH proxying are rejected until a Firecracker network path can enforce
the same policy without generic NAT.

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
