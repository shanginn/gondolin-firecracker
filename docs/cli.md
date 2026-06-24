# CLI

## Requirements

- Linux with `/dev/kvm`
- Firecracker on `PATH` or `GONDOLIN_FIRECRACKER`
- Node.js `>=23.6`

## Shell

```bash
gondolin bash [options] [-- COMMAND [ARGS...]]
```

Common options:

- `--image IMAGE` - asset directory, build id, or `name:tag`
- `--rootfs-size SIZE` - grow the effective writable root disk
- `--mount-hostfs HOST:GUEST[:ro]` - mount a host directory
- `--mount-memfs PATH` - mount an in-memory provider
- `--listen [HOST:PORT]` - expose guest HTTP services on the host
- `--ssh` - enable host-to-guest SSH access
- `--resume ID_OR_PATH` - resume from a snapshot id or `.raw` path
- `--env KEY=VALUE` - set command environment
- `--cwd PATH` - set command working directory

Examples:

```bash
gondolin bash
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
```

## Environment

- `GONDOLIN_FIRECRACKER` - Firecracker binary path
- `GONDOLIN_RUNTIME_DIR` - short writable directory for Unix sockets
- `GONDOLIN_GUEST_DIR` - local guest asset directory
- `GONDOLIN_DEFAULT_IMAGE` - default image selector
- `GONDOLIN_CHECKPOINT_DIR` - snapshot cache directory
- `GONDOLIN_DEBUG` - comma-separated debug components

## Network

Guest egress networking is disabled in the Firecracker runtime. CLI egress
policy flags are rejected. Host-to-guest ingress (`--listen`) and host-to-guest
SSH (`--ssh`) are supported.
