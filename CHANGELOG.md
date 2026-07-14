# Changelog

All notable changes to Gondolin are documented here.

## Unreleased

- Add managed TruffleHog host suggestions for unscoped CLI secrets, shared
  secret markers, and the `gondolin tools trufflehog` helper workflow; update
  the managed helper to `3.95.9` with compiled archive/executable checksums,
  reviewed GitHub endpoint mapping, fail-closed selection, and no source cache.
- Update CI and the multitenant simulator to Firecracker `1.16.1`, including
  archive checksum verification.
- Cut Firecracker cold-start overhead with native config-file launch, adaptive
  API readiness polling, persistent API connections, correct running-state
  readiness, and coalesced guest mount validation.
- Preserve sparse Linux rootfs images in writable COW mode and use APFS clone
  copies on macOS.
- Add a stripped static guest init, smaller stripped guest helpers and kernel,
  and a compact initramfs-root profile with hard-linked compatibility assets
  and a minimal placeholder root disk.
- Reduce host CLI startup, VFS/RPC, exec framing, virtio framing, and mediated
  network allocation overhead.
- Reduce npm package size and repeated typecheck/check latency, and add
  multi-run backend and host hot-path benchmarks.
- Make Firecracker the default Linux backend and add experimental vfkit
  support for local Apple Silicon development.
- Remove the legacy QEMU and libkrun backend packages, controllers, workflows,
  docs, and tests.
- Use raw root disks and raw disk checkpoints.
- Default to a low-footprint Firecracker profile: `1` vCPU, `84M`, read-only
  rootfs, no serial console, and no guest egress network.
- Mediate optional Firecracker guest egress through the host networking stack
  without installing generic host NAT rules.
