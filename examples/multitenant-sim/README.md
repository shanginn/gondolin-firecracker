# Gondolin Multitenant User Simulator

A playable load simulator for a service that gives each active user a lightweight
PI-style session backed by a Gondolin Firecracker VM. It does not call an LLM.
Each simulated message writes a tiny prompt payload, runs a small command inside
the session backend, records latency, then schedules the next message from that
user's behavior profile.

The dashboard starts as an arcade-style control surface instead of a lab report:
turn up the crowd, VM slots, arrivals, and tempo; watch users queue, boot, send
messages, and leave.

## Modes

- `SIM_BACKEND=mock` runs everywhere and is good for dashboard work.
- `SIM_BACKEND=gondolin` creates real Gondolin VMs and needs Linux/KVM,
  Firecracker, and guest assets.

The Kubernetes manifests use `SIM_BACKEND=gondolin` but also set
`SIM_PAUSED_ON_START=true`, so applying them does not create VM load until the
dashboard is started.

## Local Run

```bash
pnpm --filter @earendil-works/gondolin-multitenant-sim dev
```

Open <http://localhost:8080>. For real VMs on a KVM host:

```bash
SIM_BACKEND=gondolin pnpm --filter @earendil-works/gondolin-multitenant-sim dev
```

Useful env caps:

- `SIM_MAX_ACTIVE_USERS`, default `24`
- `SIM_MAX_ACTIVE_VMS`, default `8`
- `SIM_MAX_SPAWN_RATE_PER_MINUTE`, default `60`
- `SIM_MAX_TEMPO`, default `8`
- `SIM_VM_MEMORY`, default `84M`
- `SIM_VM_IMAGE`, optional image selector or asset directory
- `SIM_VM_NET_ENABLED`, default `false`
- `SIM_VM_CPU_WORK_KIB`, default `64`

## Build Image

Build from the repo root:

```bash
docker build \
  -f examples/multitenant-sim/Dockerfile \
  -t ghcr.io/example/gondolin-user-sim:latest \
  .
```

Push the image to your own registry, then update the kustomize image name:

```bash
cd examples/multitenant-sim/k8s
kustomize edit set image ghcr.io/example/gondolin-user-sim=registry.example.com/team/gondolin-user-sim:tag
```

Do not commit private registry names if this example is meant to stay generic.

## Kubernetes

The base is intentionally small:

- `ClusterIP` service only
- one replica
- traffic paused on startup
- `/dev/kvm` requested through the common KubeVirt device-plugin resource name
- read-only container root filesystem
- writable `emptyDir` volumes for Gondolin runtime, cache, work, and `/tmp`
- tiny Firecracker image selector with guest egress disabled by default

Deploy with your own context name from the command line:

```bash
kubectl --context <your-context> apply -k examples/multitenant-sim/k8s
kubectl --context <your-context> -n gondolin-sim rollout status deploy/gondolin-user-sim
kubectl --context <your-context> -n gondolin-sim port-forward svc/gondolin-user-sim 8080:80
```

Then open <http://localhost:8080>.

Keep cluster context names, namespaces from real environments, private registry
paths, and production-specific patches out of committed files. Put those in your
local shell history, a private overlay, or your deployment system.

The base manifests select `SIM_VM_IMAGE=alpine-tiny-firecracker:latest` and
`SIM_VM_MEMORY=30M`. Set `SIM_VM_NET_ENABLED=true` only in a private overlay
that also grants `/dev/net/tun`, `NET_ADMIN`, and `NET_RAW` to the pod.

## KVM Notes

The manifests assume a KVM device plugin that exposes
`devices.kubevirt.io/kvm`. If your cluster uses a different resource name,
patch `k8s/deployment.yaml` in a private overlay.

If your cluster has no KVM device plugin, use the hostPath privileged fallback
from `docs/kubernetes.md` only in a node-trusted environment.
