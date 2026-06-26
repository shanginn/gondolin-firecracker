# Gondolin Multitenant Simulator

This example simulates many logical users sharing a smaller pool of tiny
Firecracker VMs. Each task runs a deterministic PI-style session:

- host writes task input through VFS
- guest bash edits files under `/data/workspace`
- guest bash performs an HTTP request with `/dev/tcp` when networking is enabled
- host reads the result back through VFS

No LLM is involved. The goal is to compare lifecycle strategies and watch
resource usage.

## Run

Build or provide the tiny image on a Linux/KVM host:

```bash
scripts/build-tiny-firecracker-kernel.sh
scripts/build-fast-agent-init.sh
pnpm gondolin build --config images/alpine-tiny-firecracker.json --output ./guest/image/tiny
```

Start the dashboard:

```bash
GONDOLIN_SIM_IMAGE=./guest/image/tiny \
GONDOLIN_SIM_MEMORY=30M \
node examples/multitenant-sim/src/server.ts
```

Open `http://127.0.0.1:8787`.

Health checks can use `GET /api/health` or `HEAD /api/health`.

## Strategies

- `cold`: close every VM after each task
- `hot`: keep idle VMs running for `hotIdleTtlMs`, then close
- `warm-snapshot`: save Firecracker VM-state after each task, then close
- `hybrid`: keep a hot VM briefly, save VM-state on TTL or pressure, then close

VM-state snapshots are same-host warm states. VFS workspace directories under
`GONDOLIN_SIM_WORK_DIR` are the durable user state.

Boots and restores are bounded by `GONDOLIN_SIM_START_TIMEOUT_MS`. If a warm
restore fails or times out, the simulator records the failure, deletes that warm
state, and cold-boots the user so the queue keeps moving.

## Useful Environment

```bash
GONDOLIN_SIM_PORT=8787
GONDOLIN_SIM_IMAGE=./guest/image/tiny
GONDOLIN_SIM_WORK_DIR=/var/lib/gondolin-sim
GONDOLIN_SIM_USERS=1000
GONDOLIN_SIM_RATE=5
GONDOLIN_SIM_MAX_VMS=32
GONDOLIN_SIM_BOOT_CONCURRENCY=4
GONDOLIN_SIM_STRATEGY=hybrid
GONDOLIN_SIM_MEMORY=30M
GONDOLIN_SIM_START_TIMEOUT_MS=30000
GONDOLIN_SIM_NETWORK=true
```

## Deploy Shape

Run it on the same kind of host you use for Gondolin: Linux, `/dev/kvm`,
Firecracker on `PATH`, `/dev/net/tun`, and the networking capabilities required
by mediated egress.

Minimal systemd unit:

```ini
[Unit]
Description=Gondolin multitenant simulator
After=network.target

[Service]
WorkingDirectory=/opt/gondolin-firecracker
Environment=GONDOLIN_SIM_IMAGE=/opt/gondolin-firecracker/guest/image/tiny
Environment=GONDOLIN_SIM_WORK_DIR=/var/lib/gondolin-sim
Environment=GONDOLIN_SIM_PORT=8787
ExecStart=/usr/bin/node examples/multitenant-sim/src/server.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
