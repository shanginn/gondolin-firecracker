import fs from "fs";
import zlib from "zlib";

import type { Architecture } from "./config.ts";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);
const PE_MAGIC = Buffer.from([0x4d, 0x5a]);

type MaterializeFirecrackerKernelOptions = {
  /** source kernel image path */
  sourceKernelPath: string;
  /** output Firecracker kernel image path */
  outputKernelPath: string;
  /** target guest architecture */
  arch: Architecture;
  /** progress logger */
  log?: (message: string) => void;
};

/** Create a Firecracker-bootable kernel image from an Alpine kernel package artifact */
export function materializeFirecrackerKernel(
  options: MaterializeFirecrackerKernelOptions,
): boolean {
  const source = fs.readFileSync(options.sourceKernelPath);
  const acceptedSource = firecrackerKernelPayload(source, options.arch);
  if (acceptedSource) {
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

    if (firecrackerKernelPayload(decompressed, options.arch)) {
      fs.writeFileSync(options.outputKernelPath, decompressed);
      return true;
    }
  }

  options.log?.(
    `Skipping Firecracker kernel: ${options.sourceKernelPath} is not a supported Firecracker ${options.arch} kernel image`,
  );
  return false;
}

function firecrackerKernelPayload(
  payload: Buffer,
  arch: Architecture,
): boolean {
  if (arch === "x86_64") return startsWith(payload, ELF_MAGIC);
  if (arch === "aarch64") return startsWith(payload, PE_MAGIC);
  return false;
}

function startsWith(value: Buffer, prefix: Buffer): boolean {
  return (
    value.length >= prefix.length &&
    value.subarray(0, prefix.length).equals(prefix)
  );
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
