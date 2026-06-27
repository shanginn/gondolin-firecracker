# Custom Images

`gondolin build` creates Alpine guest assets for the VM backends.

```bash
gondolin build --config images/alpine-base.json --output ./guest/image/out
```

Required output files:

- `manifest.json`
- `vmlinuz-virt`
- `firecracker-kernel`
- `vfkit-kernel` for aarch64 vfkit images
- `initramfs.cpio.lz4`
- `rootfs.ext4`

The manifest records `assets.firecrackerKernel`; Gondolin uses that kernel when
booting Firecracker. `assets.firecrackerInitrd: null` tells Gondolin to boot
Firecracker without an initrd. For aarch64 builds, the builder also extracts an
uncompressed arm64 Linux Image from Alpine's zboot kernel and records it as
`assets.vfkitKernel`; Gondolin uses that kernel when booting vfkit.

Build a local Apple Silicon vfkit image with:

```bash
gondolin build --config images/alpine-vfkit.json --output ./guest/image/vfkit --tag alpine-vfkit:local
gondolin exec --vmm vfkit --image alpine-vfkit:local -- uname -m
```

The vfkit config forces Docker-based image assembly so macOS hosts do not need
`mke2fs`, `cpio`, or `lz4` installed directly.

Publish a CI-built Apple Silicon image with:

```bash
gh workflow run image-release.yml -f image_tag=0.1.0 -f build_config=images/alpine-vfkit.json
```

The Image Release workflow builds the architectures declared by
`release.arches` in the config and packages every asset listed in the manifest,
including `vfkit-kernel`. Once the registry entry is available, macOS users only
need `vfkit` at runtime:

```bash
gondolin exec --vmm vfkit --image alpine-vfkit:latest -- uname -m
```

When publishing from a fork, set `GONDOLIN_IMAGE_REGISTRY_URL` to that fork's
raw `builtin-image-registry.json` until the image entry is available in the
default upstream registry.

## Minimal Config

```json
{
  "imageName": "alpine-base",
  "arch": "x86_64",
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": ["linux-virt", "bash", "ca-certificates", "curl"],
    "initramfsPackages": []
  },
  "rootfs": {
    "label": "gondolin-root"
  }
}
```

## Tiny Firecracker Profile

For bash, VFS file edits, and mediated HTTP at the lowest measured memory floor,
build the tiny PVH/KVM kernel first:

```bash
scripts/build-tiny-firecracker-kernel.sh
scripts/build-fast-agent-init.sh
gondolin build --config images/alpine-tiny-firecracker.json --output ./guest/image/tiny
gondolin build --config images/alpine-fast-firecracker.json --output ./guest/image/fast
gondolin build --config images/alpine-initramfs-firecracker.json --output ./guest/image/initramfs
```

The kernel build needs `build-essential`, `bc`, `bison`, `flex`, `libelf-dev`,
`libssl-dev`, and `xz-utils` on Debian/Ubuntu hosts. The config keeps virtio
block, virtio net, vsock, ext4, FUSE, ptys, IPv4, and shell process support,
then drops the Firecracker initrd. On June 26, 2026, the tiny and fast profiles
passed `20/20` smoke boots at `29M`; use `30M` for a small guard band.

This tiny profile is a Firecracker profile, not a local macOS vfkit profile.
The checked-in config is x86_64 and the tiny kernel build targets PVH/KVM. On
Apple Silicon, vfkit needs an aarch64 image and an arm64 kernel suitable for
vfkit's Linux bootloader. Use `images/alpine-vfkit.json` for a working local
macOS profile; build vfkit tiny support as a separate aarch64 image profile
instead of reusing `images/alpine-tiny-firecracker.json`.

`images/alpine-fast-firecracker.json` additionally uses a stripped static
`/init` built by `scripts/build-fast-agent-init.sh`. It starts only the agent
path: mounts, optional DHCP, `sandboxfs`, and `sandboxd`.

`images/alpine-initramfs-firecracker.json` boots the same static init directly
from `initramfs.cpio.lz4`. It copies `sandboxd`, `sandboxfs`, bash, and
certificates into initramfs, so it can skip the rootfs mount path. Gondolin still
emits `rootfs.ext4` because the asset manifest format expects one. The
initramfs-root profile passed `20/20` smoke boots at `50M`; `49M` failed on the
same host.

Build config knobs:

- `init.rootfsInitBinary`: copy this executable to `/init`
- `init.initramfsRoot`: copy the root init path into initramfs `/init` instead
  of using the default `switch_root` initramfs script
- `vfkitKernelPath`: use this uncompressed arm64 kernel for vfkit instead of
  extracting one from the Alpine kernel package

## Runtime Requirements

- Guest architecture must match the host architecture.
- Include `e2fsprogs` when using `rootfs.size`.
- Include `openssh` when using `vm.enableSsh()` or `gondolin bash --ssh`.
- Include `python3`, `nodejs`, `npm`, or `uv` only for workloads that need them.
- Put persistent data on VFS mounts; the default rootfs is read-only.

## Using Assets

```bash
gondolin bash --image ./guest/image/out
```

```ts
const vm = await VM.create({
  sandbox: { imagePath: "./guest/image/out" },
});
```
