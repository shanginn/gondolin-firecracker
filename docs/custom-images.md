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
booting Firecracker.

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
