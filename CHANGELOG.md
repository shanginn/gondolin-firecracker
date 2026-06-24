# Changelog

All notable changes to Gondolin are documented here.

## Unreleased

- Make Firecracker the only VM backend.
- Remove legacy backend packages, controllers, workflows, docs, and tests.
- Use raw root disks and raw disk checkpoints.
- Default to a low-footprint Firecracker profile: `1` vCPU, `256M`, read-only
  rootfs, no serial console, and no guest egress network.
- Reject mediated guest egress options until a Firecracker path can enforce host
  policy without generic NAT.
