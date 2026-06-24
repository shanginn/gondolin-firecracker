import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { materializeFirecrackerKernel } from "../src/build/firecracker-kernel.ts";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

test("builder: materializeFirecrackerKernel extracts gzip ELF payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-fc-kernel-"));

  try {
    const source = path.join(dir, "vmlinuz-virt");
    const output = path.join(dir, "firecracker-kernel");
    const payload = Buffer.concat([ELF_MAGIC, Buffer.from("payload")]);
    const bzImageLike = Buffer.concat([
      Buffer.from("setup"),
      zlib.gzipSync(payload),
      Buffer.from("trailer"),
    ]);
    fs.writeFileSync(source, bzImageLike);

    assert.equal(
      materializeFirecrackerKernel({
        sourceKernelPath: source,
        outputKernelPath: output,
        arch: "x86_64",
      }),
      true,
    );
    assert.deepEqual(fs.readFileSync(output), payload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("builder: materializeFirecrackerKernel rejects unsupported x86 payloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-fc-kernel-"));

  try {
    const source = path.join(dir, "vmlinuz-virt");
    const output = path.join(dir, "firecracker-kernel");
    fs.writeFileSync(source, Buffer.from("not a kernel"));

    assert.equal(
      materializeFirecrackerKernel({
        sourceKernelPath: source,
        outputKernelPath: output,
        arch: "x86_64",
      }),
      false,
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
