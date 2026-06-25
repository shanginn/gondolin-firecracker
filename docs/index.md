# Gondolin Documentation

Gondolin runs untrusted code inside Linux/KVM Firecracker micro-VMs and exposes a
host-side TypeScript control plane for command execution, VFS mounts, host-to-
guest SSH, ingress, images, and disk checkpoints.

```bash
npx @earendil-works/gondolin bash
```

```ts
import { VM, MemoryProvider } from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: { "/workspace": new MemoryProvider() },
  },
});

const result = await vm.exec("echo hello");
console.log(result.stdout);
await vm.close();
```

Guest egress networking is disabled by default. When enabled, Firecracker uses a
TAP device and Gondolin mediates DNS, TCP, HTTP(S), mapped TCP, and outbound SSH
in the host process. Host-to-guest ingress and SSH are supported separately.

## Using Gondolin

- [Workloads](./workloads.md): typical workloads and lifecycles
- [CLI](./cli.md): run shells/commands, list sessions, attach, and snapshot
- [Ingress](./ingress.md): expose guest HTTP servers on the host
- [SSH](./ssh.md): enable host-to-guest SSH access
- [Debug Logging](./debug.md): debug output and failure hints

## SDK

- [SDK Overview](./sdk.md): entry point and API map
- [VM Lifecycle & Command Execution](./sdk-vm.md): `VM`, `vm.exec()`, and streams
- [Networking, Ingress, and SSH](./sdk-network.md): supported network surface
- [Filesystem, Guest Assets, and Snapshots](./sdk-storage.md): VFS, images, and raw checkpoints

## Images & Filesystem

- [VFS Providers](./vfs.md): host-provided mounts and filesystem policies
- [Snapshots](./snapshots.md): disk-only raw checkpoints
- [Custom Images](./custom-images.md): build guest images
- [Kubernetes](./kubernetes.md): run inside Kubernetes pods

## Design & Internals

- [Architecture Overview](./architecture.md): components and data flow
- [Security Design](./security.md): threat model and guarantees
- [Network Stack](./network.md): current network behavior
- [Firecracker Runtime](./backends.md): runtime constraints and defaults
- [Limitations](./limitations.md): current limits
