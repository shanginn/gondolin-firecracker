# Security Design

Gondolin runs untrusted code inside a Linux VM and exposes only a small
host-controlled surface: exec, VFS, host-to-guest SSH, ingress, image loading,
and disk checkpoints. Firecracker on Linux/KVM is the production backend; vfkit
on macOS is experimental local-development support.

## Threat Model

The guest is untrusted. The host process, host OS, VMM binary, and guest image
supply chain are trusted.

Gondolin does not try to defend against a malicious host user, hypervisor
escape bugs, side channels, or complete denial of service by a workload.

## Guarantees

- Guest code runs inside a Linux VM boundary.
- The base rootfs is read-only by default.
- Writable rootfs modes use temporary raw disk copies.
- VFS access is explicit and host-provided.
- Host-to-guest SSH and ingress bind through host-controlled forwarders.
- Guest egress networking is disabled by default.
- When guest egress is enabled on Firecracker, TAP frames are mediated by
  Gondolin policy hooks; Gondolin does not install generic host NAT rules.
- vfkit mediated guest egress is not implemented yet.

## Secrets

Do not pass real secrets into guest environment variables or files unless the
workload is allowed to read them. HTTP secret injection is available only for
policy-mediated guest HTTP(S) egress and should be scoped with `--allow-host` or
equivalent SDK hooks.

## Host Requirements

- Firecracker backend: Linux/KVM host with `/dev/kvm`
- Firecracker backend: Firecracker on `PATH` or `GONDOLIN_FIRECRACKER`
- vfkit backend: macOS with `vfkit` on `PATH` or `GONDOLIN_VFKIT`
- Python 3, iproute2, `/dev/net/tun`, `CAP_NET_ADMIN`, and `CAP_NET_RAW` for
  mediated guest egress
- short writable `GONDOLIN_RUNTIME_DIR` for Unix sockets
- writable image cache
- scratch storage sized for temporary raw rootfs copies when using writable root
  disks

For multi-tenant hosts, run Firecracker with the upstream jailer or equivalent
cgroup, namespace, seccomp, and filesystem confinement. Kubernetes deployments
should use KVM-capable node pools and explicit device access.
