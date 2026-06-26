# Custom Images

`gondolin build` creates Firecracker-ready Alpine guest assets.

```bash
gondolin build --config images/alpine-base.json --output ./guest/image/out
```

Required output files:

- `manifest.json`
- `vmlinuz-virt`
- `firecracker-kernel`
- `initramfs.cpio.lz4`
- `rootfs.ext4`

The manifest records `assets.firecrackerKernel`; Gondolin uses that kernel when
booting Firecracker. `assets.firecrackerInitrd: null` tells Gondolin to boot
Firecracker without an initrd.

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
gondolin build --config images/alpine-tiny-firecracker.json --output ./guest/image/tiny
```

The kernel build needs `build-essential`, `bc`, `bison`, `flex`, `libelf-dev`,
`libssl-dev`, and `xz-utils` on Debian/Ubuntu hosts. The config keeps virtio
block, virtio net, vsock, ext4, FUSE, ptys, IPv4, and shell process support,
then drops the Firecracker initrd. On June 26, 2026, this profile passed `20/20`
smoke boots at `29M`; use `30M` for a small guard band.

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
