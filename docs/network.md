# Network

Guest egress is disabled by default. This keeps the default Firecracker profile
small: no TAP setup, no guest DHCP, and no extra container capabilities.

When `sandbox.netEnabled: true` or SDK/CLI egress policy options are used,
Gondolin creates a short-lived TAP device for Firecracker and handles guest
frames in the host process. The host policy stack provides:

- DHCP and default route configuration
- DNS modes: `synthetic`, `trusted`, and `open`
- HTTP(S) interception through `httpHooks` and CLI `--allow-host`
- mapped TCP egress through `tcp` or CLI `--tcp-map`
- outbound SSH proxying through `ssh` or CLI `--ssh-allow-host`

Gondolin does not install host NAT or iptables rules. Guest packets leave only
through the mediated host sockets, so Kubernetes or host firewall policy should
be applied to the Gondolin process/pod.

Host requirements for mediated egress:

- Python 3
- `ip` from iproute2
- `/dev/net/tun`
- `CAP_NET_ADMIN`
- `CAP_NET_RAW`
