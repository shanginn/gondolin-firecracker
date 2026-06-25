# Firecracker Runtime

Gondolin has one VM backend: Firecracker.

## Requirements

- Linux host with `/dev/kvm`
- Firecracker binary in `PATH` or configured with `GONDOLIN_FIRECRACKER`
- Guest image architecture matching the host architecture
- Image manifest with `assets.firecrackerKernel`

## Defaults

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

## Storage

The base rootfs is attached read-only by default. `rootfs.mode="cow"` and
`rootfs.mode="memory"` create a temporary raw rootfs copy and delete it on close.
`rootfs.size` grows the effective writable raw disk before boot.

## Network

Guest egress is disabled by default. `netEnabled: true`, `httpHooks`, DNS
overrides, mapped TCP, or outbound SSH proxying enable a short-lived Firecracker
TAP device that is mediated by the host policy stack. Gondolin does not install
generic host NAT rules.

Host-to-guest ingress and optional host-to-guest SSH are supported over
vsock-backed forwarders. SSH requires a guest image with OpenSSH installed.

## Production Notes

Use short socket paths with `GONDOLIN_RUNTIME_DIR=/run/gondolin`, pin workloads
to KVM-capable nodes, and run Firecracker under the upstream jailer or equivalent
cgroup/namespace/seccomp confinement when operating multi-tenant hosts.
