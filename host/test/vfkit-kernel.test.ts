import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import test from "node:test";

import { materializeVfkitKernel } from "../src/build/vfkit-kernel.ts";

function arm64Image(payload = "kernel"): Buffer {
  const image = Buffer.alloc(0x40 + payload.length);
  image.write("ARMd", 0x38, "ascii");
  image.write(payload, 0x40, "ascii");
  return image;
}

test("vfkit kernel: accepts uncompressed arm64 Image", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-vfkit-kernel-"));
  try {
    const source = path.join(dir, "Image");
    const out = path.join(dir, "vfkit-kernel");
    const image = arm64Image("direct");
    fs.writeFileSync(source, image);

    assert.equal(
      materializeVfkitKernel({
        sourceKernelPath: source,
        outputKernelPath: out,
        arch: "aarch64",
      }),
      true,
    );
    assert.deepEqual(fs.readFileSync(out), image);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("vfkit kernel: extracts arm64 Image from zboot gzip payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-vfkit-kernel-"));
  try {
    const source = path.join(dir, "vmlinuz-virt");
    const out = path.join(dir, "vfkit-kernel");
    const image = arm64Image("compressed");
    const gzip = zlib.gzipSync(image);
    const wrapper = Buffer.concat([Buffer.from("MZ\0\0zimg"), gzip]);
    fs.writeFileSync(source, wrapper);

    assert.equal(
      materializeVfkitKernel({
        sourceKernelPath: source,
        outputKernelPath: out,
        arch: "aarch64",
      }),
      true,
    );
    assert.deepEqual(fs.readFileSync(out), image);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("vfkit kernel: skips unsupported architectures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-vfkit-kernel-"));
  try {
    const source = path.join(dir, "vmlinuz");
    const out = path.join(dir, "vfkit-kernel");
    fs.writeFileSync(source, arm64Image("wrong-arch"));

    assert.equal(
      materializeVfkitKernel({
        sourceKernelPath: source,
        outputKernelPath: out,
        arch: "x86_64",
      }),
      false,
    );
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
