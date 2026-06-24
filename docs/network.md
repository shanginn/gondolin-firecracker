# Network

The Firecracker runtime does not attach a guest egress network device.

Supported network-adjacent features:

- host-to-guest ingress with `vm.enableIngress()` or `gondolin bash --listen`
- host-to-guest SSH with `vm.enableSsh()` or `gondolin bash --ssh`
- VFS-backed file exchange

Unsupported and rejected:

- `netEnabled: true`
- `httpHooks`
- DNS overrides
- mapped TCP egress
- outbound SSH proxying

This is intentional. A generic TAP/NAT path would give the guest network access
without Gondolin policy enforcement. Add egress only with a Firecracker path that
keeps the host as the enforcement point.
