# Architecture Overview

Gondolin is a Linux VM runtime plus a Node.js control plane.

## Components

- **Host package and CLI** start the selected VMM, manage guest assets, expose
  `VM`, and provide VFS/exec/SSH/ingress services.
- **Guest image** is Alpine Linux with small Zig daemons.
- **VMM backend** is Firecracker on Linux/KVM or experimental vfkit on macOS.

## Guest Daemons

- `sandboxd`: command execution over vsock
- `sandboxfs`: FUSE-backed VFS RPC over vsock
- `sandboxssh`: host-to-guest SSH TCP forwarder over vsock
- `sandboxingress`: host-to-guest ingress TCP forwarder over vsock

## Data Flow

```
trusted host process
  |
  | VMM process control
  v
VMM process
  |
  | vsock ports 1024-1027
  v
guest daemons
```

The guest has no egress network device in the default runtime. Command
execution, VFS, host-to-guest SSH, and ingress do not need guest networking.

## Storage

The base rootfs is attached read-only by default for fast startup and low disk
churn. Writable modes create a temporary raw rootfs copy. VFS mounts should hold
workspace and persistent data.

## Enforcement

The VM boundary isolates compute. The host controls every exposed channel:
exec, VFS, SSH, ingress, checkpointing, and image selection. Guest egress is
disabled until a backend network path can enforce Gondolin policy without
falling back to generic NAT. Today that mediated egress path exists for
Firecracker only.
