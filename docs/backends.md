# VM Backends: QEMU, libkrun, and Firecracker

Gondolin supports three VM backends:

- `qemu` (default, broader feature support)
- `krun` (experimental, uses `libkrun` via `host/krun-runner`)
- `firecracker` (experimental, Linux/KVM only)

This page is the authoritative backend-parity reference for SDK/CLI behavior.

## Feature Parity Matrix

| Capability / setting                                             | `qemu` | `krun` | `firecracker` | Notes                                                                                                                                          |
| ---------------------------------------------------------------- | ------ | ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.vmm`                                                    | ✓      | ✓      | ✓             | Select backend (`"qemu"`, `"krun"`, or `"firecracker"`)                                                                                        |
| `sandbox.qemuPath`                                               | ✓      |        |               | Rejected when `vmm` is not `qemu`                                                                                                               |
| `sandbox.krunRunnerPath`                                         |        | ✓      |               | Used only with `vmm=krun`                                                                                                                      |
| `sandbox.firecrackerPath`                                        |        |        | ✓             | Firecracker binary path; defaults to `GONDOLIN_FIRECRACKER` or `firecracker`                                                                   |
| `sandbox.firecrackerApiSocketPath` / `firecrackerVsockPath`      |        |        | ✓             | Optional explicit host socket paths                                                                                                            |
| `sandbox.firecrackerGuestCid`                                    |        |        | ✓             | Guest vsock CID; must be at least `3`                                                                                                          |
| `sandbox.machineType`                                            | ✓      |        |               | Rejected when `vmm` is not `qemu`                                                                                                               |
| `sandbox.accel`                                                  | ✓      |        |               | Rejected when `vmm` is not `qemu`; krun and Firecracker acceleration are backend-specific                                                      |
| `sandbox.cpu`                                                    | ✓      |        |               | Rejected when `vmm` is not `qemu`                                                                                                               |
| `sandbox.cpus`                                                   | ✓      | ✓      | ✓             | Shared high-level CPU count option                                                                                                             |
| `sandbox.memory`                                                 | ✓      | ✓      | ✓             | Parsed to MiB for krun/Firecracker; Firecracker defaults to `256M`                                                                             |
| `sandbox.rootDiskPath` / `rootDiskFormat` / `rootDiskReadOnly`   | ✓      | ✓      | raw only      | Firecracker requires a raw root disk in this implementation                                                                                    |
| Default rootfs mode                                              | `cow`  | `cow`  | `readonly`    | Firecracker defaults to a read-only base rootfs to avoid raw-copy startup/storage cost; set `rootfs.mode="cow"` when writes outside tmpfs/VFS are needed |
| `rootfs.mode = "memory"`                                         | ✓      | ✓      | ✓             | QEMU can use backend snapshot mode; krun uses a temporary qcow2 overlay; Firecracker uses a temporary raw copy                                  |
| `rootfs.mode = "cow"`                                            | ✓      | ✓      | ✓             | QEMU/krun use qcow2 copy-on-write overlays; Firecracker uses a temporary raw copy                                                              |
| `rootfs.size`                                                     | ✓      | ✓      | ✓             | Ensures the effective writable root disk is at least the requested size before boot and runs `resize2fs` in the guest; requires `resize2fs` in the image |
| `vm.checkpoint()` / checkpoint resume                            | ✓      | ✓      |               | Resume enforces checkpoint compatibility metadata; Firecracker root disks are raw copies and are not checkpointable yet                         |
| Exec/VFS/SSH/ingress APIs                                        | ✓      | ✓      | ✓             | QEMU/krun use virtio-serial; Firecracker uses vsock                                                                                             |
| Mediated guest network egress (`httpHooks`, DNS, mapped TCP/SSH) | ✓      | ✓      |               | Firecracker mediated networking is not implemented yet                                                                                         |

## Architecture and Kernel Constraints

### QEMU

- Guest architecture must match the selected QEMU binary (`qemu-system-aarch64` vs `qemu-system-x86_64`)
- QEMU binary precedence: explicit `sandbox.qemuPath` → manifest-derived default when guest arch is known → host-arch default fallback
- CPU model precedence: explicit `sandbox.cpu` → `GONDOLIN_CPU` → backend-specific auto selection
- Kernel/initrd/rootfs come from selected guest assets

### krun

- Guest architecture must match the **host** architecture
- Requires a **libkrunfw-compatible kernel**
- Gondolin requires image manifest krun boot assets:
    - `assets.krunKernel`
    - `assets.krunInitrd` (optional; defaults to an empty initrd)
- Build/setup path: `gondolin build` (or published image assets)
- `make krun-runner` builds the runner binary; it does not provide kernel assets

Runner path resolution:

- Auto-detected from local `host/krun-runner/zig-out/bin/gondolin-krun-runner` when present
- Auto-detected from installed platform runner package when available (for example `@earendil-works/gondolin-krun-runner-darwin-arm64` or `@earendil-works/gondolin-krun-runner-linux-x64`)

### Firecracker

- Host must be Linux with `/dev/kvm`
- Guest architecture must match the **host** architecture
- Requires the Firecracker binary (`sandbox.firecrackerPath`, `GONDOLIN_FIRECRACKER`, or `firecracker` on `PATH`)
- Kernel/initrd/rootfs come from selected guest assets; if present, manifest `assets.firecrackerKernel` / `assets.firecrackerInitrd` override the default kernel/initramfs
- Control, VFS, SSH, and ingress channels use Firecracker vsock ports `1024` through `1027`
- Defaults are tuned for low startup cost and low steady-state footprint: `cpus=1`, `memory="256M"`, no guest serial console, quiet kernel logging, and no DHCP/network device setup
- Firecracker VM defaults use `rootfs.mode="readonly"` unless the image manifest or caller selects another mode
- Mediated networking is disabled; `netEnabled: true`, network policy options, and QEMU/krun backend knobs are rejected when `vmm=firecracker`
- For production host isolation, run Firecracker under the upstream jailer or an equivalent service manager/cgroup/namespace profile; Gondolin does not weaken Firecracker's default seccomp settings

## Runtime Caveats

- `krun` backend is still experimental and has less runtime parity coverage than `qemu`
- `firecracker` backend is still experimental and currently supports the control-plane APIs without mediated network egress
- Cross-backend checkpoint resume (`qemu` ↔ `krun`) requires assets that include `manifest.assets.krunKernel`; Firecracker checkpoints are not supported yet
- Some krun networking edge cases are still under investigation
- Host CA trust configuration can cause guest-visible HTTP `502` errors on network-mediated backends when upstream TLS validation fails

## Recommendation

Use `qemu` unless you specifically want to exercise an experimental backend. If you expose backend knobs in higher-level tooling, gate them by backend and fail fast on unsupported combinations.
