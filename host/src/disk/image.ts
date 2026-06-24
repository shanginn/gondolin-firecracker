import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

export type DiskFormat = "raw";

function tmpDir(): string {
  // macOS has tighter unix socket path limits in the default temp dir and we
  // already standardize on /tmp elsewhere.
  return process.platform === "darwin" ? "/tmp" : os.tmpdir();
}

export function assertRawDiskImage(diskPath: string): void {
  const fd = fs.openSync(diskPath, "r");
  try {
    const magic = Buffer.alloc(4);
    const n = fs.readSync(fd, magic, 0, magic.length, 0);
    if (
      n === magic.length &&
      magic[0] === 0x51 &&
      magic[1] === 0x46 &&
      magic[2] === 0x49 &&
      magic[3] === 0xfb
    ) {
      throw new Error(
        `unsupported disk image format: ${diskPath} (Firecracker requires raw block devices)`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse a disk size string into `bytes`. */
export function parseDiskSizeToBytes(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `invalid disk size: ${String(value)} (expected a positive integer byte count)`,
      );
    }
    return value;
  }

  if (typeof value !== "string") {
    throw new Error(
      `invalid disk size: ${String(value)} (expected a string like "2G")`,
    );
  }

  const trimmed = value.trim();
  const match = /^(\d+)\s*([a-zA-Z]*)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid disk size: ${JSON.stringify(value)} (expected a positive integer with optional K/M/G/T/P/E suffix)`,
    );
  }

  const amount = BigInt(match[1]!);
  if (amount <= 0n) {
    throw new Error(
      `invalid disk size: ${JSON.stringify(value)} (expected a positive integer)`,
    );
  }

  let suffix = match[2]!.toLowerCase();
  if (suffix.endsWith("ib")) {
    suffix = suffix.slice(0, -2);
  } else if (suffix.endsWith("b")) {
    suffix = suffix.slice(0, -1);
  }

  const exponents: Record<string, number> = {
    "": 0,
    byte: 0,
    bytes: 0,
    k: 1,
    m: 2,
    g: 3,
    t: 4,
    p: 5,
    e: 6,
  };
  const exponent = exponents[suffix];
  if (exponent === undefined) {
    throw new Error(
      `invalid disk size suffix: ${JSON.stringify(match[2])} (expected K/M/G/T/P/E)`,
    );
  }

  const bytes = amount * 1024n ** BigInt(exponent);
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`disk size is too large: ${JSON.stringify(value)}`);
  }
  return Number(bytes);
}

export function createTempRawCopy(sourcePath: string): string {
  const copyPath = path.join(
    tmpDir(),
    `gondolin-disk-${randomUUID().slice(0, 8)}.raw`,
  );
  try {
    fs.copyFileSync(sourcePath, copyPath);
    return copyPath;
  } catch (err) {
    fs.rmSync(copyPath, { force: true });
    throw err;
  }
}

/**
 * Move a file to a new location, falling back to copy+unlink across devices.
 */
export function moveFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err: any) {
    if (err && err.code === "EXDEV") {
      fs.copyFileSync(src, dst);
      fs.rmSync(src, { force: true });
      return;
    }
    throw err;
  }
}

/** Grow a raw image to at least `bytes`. */
export function ensureDiskImageMinimumSize(
  imagePath: string,
  sizeBytes: number,
): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`invalid disk resize target: ${String(sizeBytes)}`);
  }
  assertRawDiskImage(imagePath);
  const stat = fs.statSync(imagePath);
  if (stat.size >= sizeBytes) return;
  fs.truncateSync(imagePath, sizeBytes);
}
