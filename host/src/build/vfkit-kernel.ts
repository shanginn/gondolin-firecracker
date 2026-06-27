import fs from "fs";
import zlib from "zlib";

import type { Architecture } from "./config.ts";

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);
const ARM64_IMAGE_MAGIC = Buffer.from([0x41, 0x52, 0x4d, 0x64]);
const ARM64_IMAGE_MAGIC_OFFSET = 0x38;

type MaterializeVfkitKernelOptions = {
  /** source kernel image path */
  sourceKernelPath: string;
  /** output vfkit kernel image path */
  outputKernelPath: string;
  /** target guest architecture */
  arch: Architecture;
  /** progress logger */
  log?: (message: string) => void;
};

/** Create a vfkit-bootable kernel image from an Alpine kernel package artifact */
export function materializeVfkitKernel(
  options: MaterializeVfkitKernelOptions,
): boolean {
  if (options.arch !== "aarch64") {
    options.log?.(
      `Skipping vfkit kernel: vfkit Linux boot assets are only supported for aarch64, got ${options.arch}`,
    );
    return false;
  }

  const source = fs.readFileSync(options.sourceKernelPath);
  if (arm64ImagePayload(source)) {
    fs.copyFileSync(options.sourceKernelPath, options.outputKernelPath);
    return true;
  }

  for (const offset of findMagicOffsets(source, GZIP_MAGIC)) {
    let decompressed: Buffer;
    try {
      decompressed = inflateGzipPayload(source, offset);
    } catch {
      continue;
    }

    if (arm64ImagePayload(decompressed)) {
      fs.writeFileSync(options.outputKernelPath, decompressed);
      return true;
    }
  }

  options.log?.(
    `Skipping vfkit kernel: ${options.sourceKernelPath} is not an uncompressed aarch64 Linux Image or extractable zboot image`,
  );
  return false;
}

function arm64ImagePayload(payload: Buffer): boolean {
  const start = ARM64_IMAGE_MAGIC_OFFSET;
  const end = start + ARM64_IMAGE_MAGIC.length;
  return payload.length >= end && payload.subarray(start, end).equals(ARM64_IMAGE_MAGIC);
}

function findMagicOffsets(source: Buffer, magic: Buffer): number[] {
  const offsets: number[] = [];
  let offset = 0;

  while (offset < source.length) {
    const next = source.indexOf(magic, offset);
    if (next === -1) break;
    offsets.push(next);
    offset = next + 1;
  }

  return offsets;
}

function inflateGzipPayload(source: Buffer, offset: number): Buffer {
  const dataOffset = gzipDeflateOffset(source, offset);
  return zlib.inflateRawSync(source.subarray(dataOffset));
}

function gzipDeflateOffset(source: Buffer, offset: number): number {
  if (offset + 10 > source.length) {
    throw new Error("truncated gzip header");
  }

  const compressionMethod = source[offset + 2];
  const flags = source[offset + 3];
  if (compressionMethod !== 8 || flags === undefined) {
    throw new Error("unsupported gzip header");
  }

  let cursor = offset + 10;

  if ((flags & 0x04) !== 0) {
    if (cursor + 2 > source.length) throw new Error("truncated gzip extra");
    const extraLength = source.readUInt16LE(cursor);
    cursor += 2 + extraLength;
  }

  if ((flags & 0x08) !== 0) cursor = skipGzipCString(source, cursor);
  if ((flags & 0x10) !== 0) cursor = skipGzipCString(source, cursor);

  if ((flags & 0x02) !== 0) {
    cursor += 2;
  }

  if (cursor > source.length) {
    throw new Error("truncated gzip payload");
  }

  return cursor;
}

function skipGzipCString(source: Buffer, offset: number): number {
  const terminator = source.indexOf(0, offset);
  if (terminator === -1) {
    throw new Error("truncated gzip string");
  }
  return terminator + 1;
}

export const __test = {
  arm64ImagePayload,
};
