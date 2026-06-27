# CLI

## Requirements

- Firecracker backend: Linux with `/dev/kvm`
- Firecracker backend: Firecracker on `PATH` or `GONDOLIN_FIRECRACKER`
- vfkit backend: macOS with `vfkit` on `PATH` or `GONDOLIN_VFKIT`
- Node.js `>=23.6`

## Shell

```bash
gondolin bash [options] [-- COMMAND [ARGS...]]
```

Common options:

- `--image IMAGE` - asset directory, build id, or `name:tag`
- `--vmm firecracker|vfkit` - VM backend
- `--vfkit PATH` - vfkit binary path
- `--rootfs-size SIZE` - grow the effective writable root disk
- `--mount-hostfs HOST:GUEST[:ro]` - mount a host directory
- `--mount-memfs PATH` - mount an in-memory provider
- `--listen [HOST:PORT]` - expose guest HTTP services on the host
- `--ssh` - enable host-to-guest SSH access
- `--allow-host HOST` - allow HTTP(S) egress to host pattern
- `--host-secret NAME@HOST[,HOST...][=VALUE]` - inject an HTTP secret
- `--dns MODE` - choose `synthetic`, `trusted`, or `open` DNS mode
- `--tcp-map GUEST=UPSTREAM` - map guest TCP egress to a host target
- `--ssh-allow-host HOST[:PORT]` - allow outbound SSH proxying
- `--resume ID_OR_PATH` - resume from a snapshot id or `.raw` path
- `--env KEY=VALUE` - set command environment
- `--cwd PATH` - set command working directory

Examples:

```bash
gondolin bash
gondolin bash --vmm vfkit
gondolin exec --vmm vfkit --image alpine-vfkit:local -- uname -m
gondolin bash --mount-hostfs "$PWD":/workspace:ro --cwd /workspace
gondolin bash --listen 127.0.0.1:3000
gondolin bash --ssh
gondolin bash --resume /tmp/my-snapshot.raw
```

## Exec

```bash
gondolin exec [options] -- COMMAND [ARGS...]
gondolin exec --sock PATH -- COMMAND [ARGS...]
```

Without `--sock`, `exec` creates a VM, runs the command, and closes it. With
`--sock`, it connects to an existing session transport.

## Sessions

```bash
gondolin list
gondolin attach <session-id>
```

## Snapshots

```bash
gondolin snapshot <session-id>
gondolin snapshot <session-id> --output ./my-snapshot.raw
gondolin bash --resume ./my-snapshot.raw
```

Default snapshots are stored under
`~/.cache/gondolin/checkpoints/<uuid>.raw`.

## Images

```bash
gondolin image list
gondolin image inspect alpine-base:latest
gondolin build --config images/alpine-base.json --output ./guest/image/out
gondolin build --config images/alpine-vfkit.json --output ./guest/image/vfkit --tag alpine-vfkit:local
```

## Environment

- `GONDOLIN_FIRECRACKER` - Firecracker binary path
- `GONDOLIN_VFKIT` - vfkit binary path
- `GONDOLIN_RUNTIME_DIR` - short writable directory for Unix sockets
- `GONDOLIN_GUEST_DIR` - local guest asset directory
- `GONDOLIN_DEFAULT_IMAGE` - default image selector
- `GONDOLIN_CHECKPOINT_DIR` - snapshot cache directory
- `GONDOLIN_DEBUG` - comma-separated debug components

## Network

Guest egress networking is disabled by default. With Firecracker, `--allow-host`,
`--dns`, `--tcp-map`, `--ssh-allow-host`, and related flags enable mediated TAP
egress. Gondolin handles DHCP, DNS, TCP, HTTP(S), mapped TCP, and outbound SSH
in the host process and does not add generic host NAT rules. Host-to-guest
ingress (`--listen`) and host-to-guest SSH (`--ssh`) are separate vsock-backed
features. vfkit mediated guest egress is not implemented yet.
