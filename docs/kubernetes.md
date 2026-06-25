# Kubernetes

Gondolin can run the Firecracker backend inside Kubernetes when the pod is
scheduled onto Linux nodes that expose hardware virtualization to containers.
The pod launches Firecracker as a child process; Kubernetes is still responsible
for node selection, device access, pod filesystem limits, and pod network
policy.

## Requirements

- Linux worker node with KVM enabled
- `/dev/kvm` available inside the pod with read/write device-cgroup access
- Firecracker binary in the container image or configured with `GONDOLIN_FIRECRACKER`
- Python 3 and `ip` from iproute2 in the container image when guest egress is enabled
- Node.js `>=23.6`
- Guest image assets that include `manifest.assets.firecrackerKernel`
- Same architecture for node and guest image (`x86_64` on x86 nodes, `aarch64` on ARM nodes)

The Firecracker backend uses vsock for Gondolin control, VFS, SSH, and ingress
channels. Guest egress is disabled by default and needs no TAP device. When
`netEnabled` or egress policy options are used, Gondolin creates a short-lived
TAP device and needs `/dev/net/tun`, `CAP_NET_ADMIN`, and `CAP_NET_RAW`.

## Pod Configuration

Prefer a cluster KVM device plugin so Kubernetes grants both the device mount
and cgroup permission. The resource name is plugin-specific; `devices.kubevirt.io/kvm`
is a common example.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gondolin-worker
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gondolin-worker
  template:
    metadata:
      labels:
        app: gondolin-worker
    spec:
      nodeSelector:
        gondolin.dev/kvm: "true"
      containers:
        - name: worker
          image: ghcr.io/example/gondolin-worker:latest
          env:
            - name: GONDOLIN_RUNTIME_DIR
              value: /run/gondolin
            - name: XDG_CACHE_HOME
              value: /cache
            - name: TMPDIR
              value: /work
          volumeMounts:
            - name: runtime
              mountPath: /run/gondolin
            - name: cache
              mountPath: /cache
            - name: work
              mountPath: /work
          resources:
            requests:
              cpu: "1"
              memory: 192Mi
              ephemeral-storage: 2Gi
              devices.kubevirt.io/kvm: "1"
            limits:
              memory: 384Mi
              ephemeral-storage: 4Gi
              devices.kubevirt.io/kvm: "1"
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: runtime
          emptyDir:
            medium: Memory
            sizeLimit: 64Mi
        - name: cache
          emptyDir:
            sizeLimit: 2Gi
        - name: work
          emptyDir:
            sizeLimit: 4Gi
```

If your cluster does not have a KVM device plugin, a privileged pod with a
`/dev/kvm` hostPath mount is the usual fallback. Treat that as a node-trusted
deployment mode and isolate it with node pools, taints, admission policy, and
namespace RBAC.

```yaml
securityContext:
  privileged: true
volumeMounts:
  - name: kvm
    mountPath: /dev/kvm
volumes:
  - name: kvm
    hostPath:
      path: /dev/kvm
      type: CharDevice
```

For mediated guest egress, add `/dev/net/tun` and the network capabilities:

```yaml
securityContext:
  capabilities:
    drop: ["ALL"]
    add: ["NET_ADMIN", "NET_RAW"]
volumeMounts:
  - name: tun
    mountPath: /dev/net/tun
volumes:
  - name: tun
    hostPath:
      path: /dev/net/tun
      type: CharDevice
```

## Runtime Directories

Set `GONDOLIN_RUNTIME_DIR` to a short writable path such as `/run/gondolin`.
Firecracker and the host-side vsock bridge use Unix sockets, and Linux rejects
socket paths longer than `107` bytes. Gondolin validates this during option
resolution and again at runtime.

Set `XDG_CACHE_HOME` to a writable volume for image assets. Set `TMPDIR` to a
writable volume with enough space for temporary root disks when using
`rootfs.mode="cow"`, `rootfs.mode="memory"`, or `rootfs.size`.

## Firecracker Defaults

The Kubernetes-oriented Firecracker profile is optimized for low startup time
and memory footprint:

- `1` vCPU
- `84M` guest memory
- no serial console unless `console: "stdio"` is requested
- no guest DHCP/network device setup unless mediated egress is enabled
- `rootfs.mode="readonly"` by default

The read-only rootfs avoids a full raw rootfs copy before boot. Guest paths such
as `/tmp`, `/root`, `/var/tmp`, `/var/cache`, and `/var/log` are tmpfs-backed.
The default image pre-creates `/data` and `/etc/gondolin` for the default VFS
mount and config bind. Use VFS mounts for workspace data. If the workload must
persist writes into the root filesystem image, or if it needs custom mount
targets that are not present in the image, set `rootfs.mode="cow"` and
provision `TMPDIR` storage for one raw rootfs copy per concurrent VM.

## Network And Secrets

Guest egress is disabled by default. SDK network policy options or
`sandbox.netEnabled: true` enable a Firecracker TAP device that is mediated by
Gondolin's DHCP/DNS/TCP/HTTP(S)/SSH policy stack. Gondolin does not add NAT or
iptables rules, so guest packets cannot bypass the host policy stack through the
pod network namespace.

For Kubernetes:

- keep egress disabled for the lowest-capability pod profile and fastest startup
- enable `/dev/net/tun`, `NET_ADMIN`, and `NET_RAW` only for workloads that need
  controlled guest internet access
- apply Kubernetes `NetworkPolicy` to the pod itself, because mediated guest
  requests are made by the host process and use normal pod network access

## Operational Notes

- Pin workloads to KVM-capable node pools.
- Avoid sandboxed pod runtimes that hide or virtualize `/dev/kvm` unless nested
  virtualization is known to work.
- Size pod memory as guest memory plus Node.js/controller overhead. An `84M`
  Firecracker guest should usually request at least `192Mi`.
- Keep `GONDOLIN_RUNTIME_DIR` on memory-backed `emptyDir`; keep root disk copies
  on disk-backed `emptyDir` or persistent scratch storage.
- Use `rootfs.mode="readonly"` whenever the workload writes only to tmpfs and
  VFS mounts.
